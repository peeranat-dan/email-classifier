import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../db/firestore.js';
import * as anthropic from '../services/anthropic.js';
import * as gmail from '../services/gmail.js';
import { classifyEmail } from './classify-email.js';

// Deploy-time params, replaced by plain values each test can change
const settings = vi.hoisted(() => ({
  shadowMode: false,
  minConfidence: '0.8',
  neverArchive: [] as string[],
}));

vi.mock('../config.js', () => ({
  params: {
    gmailAddress: { value: () => 'Me@example.com' },
    shadowMode: { value: () => settings.shadowMode },
    minConfidence: { value: () => settings.minConfidence },
    neverArchive: { value: () => settings.neverArchive },
  },
}));
vi.mock('../db/firestore.js');
vi.mock('../services/anthropic.js');
vi.mock('../services/gmail.js');

const MESSAGE_ID = 'msg-1';
const THREAD_ID = 'thread-1';

function inboxEmail(overrides: Partial<gmail.EmailSummary> = {}): gmail.EmailSummary {
  return {
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    fromAddress: 'friend@example.com',
    subject: 'Lunch on Friday?',
    snippet: 'Are you free?',
    labelIds: ['INBOX', 'UNREAD'],
    hasListUnsubscribe: false,
    ...overrides,
  };
}

const kbankSlip = () =>
  inboxEmail({
    fromAddress: 'no-reply@kasikornbank.com',
    subject: 'Result of Bill Payment (Success)',
  });

const USAGE: anthropic.Usage = {
  model: 'claude-haiku-5-5',
  inputTokens: 600,
  outputTokens: 50,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0.000085,
};

function llmSays(category: anthropic.Category, confidence = 0.95) {
  vi.mocked(anthropic.classifyEmail).mockResolvedValue({
    category,
    confidence,
    reason: 'because',
    usage: USAGE,
  });
}

beforeEach(() => {
  settings.shadowMode = false;
  settings.minConfidence = '0.8';
  settings.neverArchive = [];

  vi.mocked(db.claimMessage).mockResolvedValue('claimed');
  vi.mocked(gmail.getEmail).mockResolvedValue(inboxEmail());
});

describe('classifyEmail', () => {
  describe('claiming the message', () => {
    it.each(['duplicate', 'exhausted'] as const)(
      'does nothing when the claim is %s',
      async (claim) => {
        vi.mocked(db.claimMessage).mockResolvedValue(claim);

        await expect(classifyEmail(MESSAGE_ID)).resolves.toEqual({ status: claim });

        expect(gmail.getEmail).not.toHaveBeenCalled();
        expect(gmail.applyToThread).not.toHaveBeenCalled();
      },
    );
  });

  describe('emails that are no longer worth classifying', () => {
    it('skips an email that was deleted before we got to it', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(null);

      await expect(classifyEmail(MESSAGE_ID)).resolves.toEqual({ status: 'skipped' });

      expect(db.completeMessage).toHaveBeenCalledWith(MESSAGE_ID, { outcome: 'skipped' });
      expect(gmail.applyToThread).not.toHaveBeenCalled();
    });

    it('skips an email that already left the inbox', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(inboxEmail({ labelIds: ['UNREAD'] }));

      await expect(classifyEmail(MESSAGE_ID)).resolves.toEqual({ status: 'skipped' });

      expect(anthropic.classifyEmail).not.toHaveBeenCalled();
      expect(gmail.applyToThread).not.toHaveBeenCalled();
    });
  });

  describe('our own weekly summary', () => {
    it('leaves it untouched without asking the LLM', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(
        inboxEmail({
          fromAddress: 'me@example.com',
          subject: '[email-classifier] Weekly summary: 3 archived, 1 kept (4 Oct - 11 Oct)',
        }),
      );

      await expect(classifyEmail(MESSAGE_ID)).resolves.toEqual({ status: 'skipped' });

      expect(anthropic.classifyEmail).not.toHaveBeenCalled();
      expect(gmail.applyToThread).not.toHaveBeenCalled();
    });

    it('still classifies the same subject from someone else', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(
        inboxEmail({ subject: '[email-classifier] Weekly summary: free money' }),
      );
      llmSays('archive');

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ source: 'llm' });
    });
  });

  describe('ignored mail', () => {
    it('leaves it untouched without asking the LLM', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(
        inboxEmail({
          fromAddress: 'calendar-notification@google.com',
          subject: 'Daily Agenda for Peeranat Danaidusadeekul as of 5am',
        }),
      );

      await expect(classifyEmail(MESSAGE_ID)).resolves.toEqual({ status: 'skipped' });

      expect(anthropic.classifyEmail).not.toHaveBeenCalled();
      expect(gmail.applyToThread).not.toHaveBeenCalled();
      expect(db.completeMessage).toHaveBeenCalledWith(MESSAGE_ID, {
        from: 'calendar-notification@google.com',
        subject: 'Daily Agenda for Peeranat Danaidusadeekul as of 5am',
        outcome: 'skipped',
        reason: 'ignore: google-calendar-notification',
      });
    });
  });

  describe('protected senders', () => {
    it('keeps mail from an exact address without asking the LLM', async () => {
      settings.neverArchive = ['friend@example.com'];

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({
        source: 'protected',
        label: 'Auto/Protected',
        archive: false,
        markRead: false,
      });
      expect(anthropic.classifyEmail).not.toHaveBeenCalled();
    });

    it('treats "@domain" as every address on that domain', async () => {
      settings.neverArchive = ['@example.com'];

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ source: 'protected' });
    });

    it('ignores case and surrounding spaces in the list', async () => {
      settings.neverArchive = ['  Friend@Example.COM '];

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ source: 'protected' });
    });

    it('does not cover subdomains of a protected domain', async () => {
      settings.neverArchive = ['@example.com'];
      vi.mocked(gmail.getEmail).mockResolvedValue(
        inboxEmail({ fromAddress: 'bot@mail.example.com' }),
      );
      llmSays('archive');

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ source: 'llm' });
    });

    it('wins over an archive rule', async () => {
      settings.neverArchive = ['@kasikornbank.com'];
      vi.mocked(gmail.getEmail).mockResolvedValue(kbankSlip());

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({
        source: 'protected',
        archive: false,
      });
    });
  });

  describe('rules', () => {
    it('archives and marks read without asking the LLM', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(kbankSlip());

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({
        source: 'rule',
        label: 'Auto/Archived',
        reason: 'rule: kbank-slip',
      });

      expect(anthropic.classifyEmail).not.toHaveBeenCalled();
      expect(gmail.applyToThread).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({
          addLabels: ['Auto/Archived'],
          archive: true,
          markRead: true,
        }),
      );
    });
  });

  describe('LLM decisions', () => {
    it.each([
      { category: 'action', label: 'AI/Action', archive: false },
      { category: 'important', label: 'AI/Read', archive: false },
      { category: 'archive', label: 'AI/Archived', archive: true },
    ] as const)(
      'labels "$category" as $label (archive: $archive)',
      async ({ category, label, archive }) => {
        llmSays(category);

        await classifyEmail(MESSAGE_ID);

        // An archived email is marked read; one kept in the inbox stays unread
        expect(gmail.applyToThread).toHaveBeenCalledWith(
          THREAD_ID,
          expect.objectContaining({
            addLabels: [label],
            archive,
            markRead: archive,
          }),
        );
      },
    );

    it('keeps the email as AI/Unsure when confidence is below the threshold', async () => {
      llmSays('archive', 0.79);

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({
        label: 'AI/Unsure',
        archive: false,
        confidence: 0.79,
      });
    });

    it('trusts a confidence exactly at the threshold', async () => {
      llmSays('archive', 0.8);

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ label: 'AI/Archived' });
    });
  });

  describe('threads', () => {
    it('relabels the whole thread, replacing the label an earlier message got', async () => {
      llmSays('action');

      await classifyEmail(MESSAGE_ID);

      expect(gmail.applyToThread).toHaveBeenCalledWith(THREAD_ID, {
        addLabels: ['AI/Action'],
        removeLabels: [
          'Auto/Archived',
          'Auto/WouldArchive',
          'Auto/Protected',
          'AI/Read',
          'AI/Archived',
          'AI/Unsure',
          'AI/WouldArchive',
        ],
        archive: false,
        markRead: false,
      });
    });
  });

  describe('shadow mode', () => {
    beforeEach(() => {
      settings.shadowMode = true;
    });

    it('only labels what a rule would have archived', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(kbankSlip());

      await classifyEmail(MESSAGE_ID);

      expect(gmail.applyToThread).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({
          addLabels: ['Auto/WouldArchive'],
          archive: false,
          markRead: false,
        }),
      );
    });

    it('only labels what the LLM would have archived', async () => {
      llmSays('archive');

      await classifyEmail(MESSAGE_ID);

      expect(gmail.applyToThread).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({
          addLabels: ['AI/WouldArchive'],
          archive: false,
          markRead: false,
        }),
      );
    });

    it('leaves decisions that keep the email unchanged', async () => {
      llmSays('action');

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ label: 'AI/Action' });
    });
  });

  describe('classification log', () => {
    it('records the sender, subject and decision of an archived email', async () => {
      llmSays('archive', 0.9);

      await classifyEmail(MESSAGE_ID);

      expect(db.completeMessage).toHaveBeenCalledWith(MESSAGE_ID, {
        from: 'friend@example.com',
        subject: 'Lunch on Friday?',
        outcome: 'archived',
        source: 'llm',
        label: 'AI/Archived',
        archive: true,
        markRead: true,
        reason: 'because',
        confidence: 0.9,
        usage: USAGE,
      });
    });

    it('records a shadow-mode archive as kept', async () => {
      settings.shadowMode = true;
      llmSays('archive');

      await classifyEmail(MESSAGE_ID);

      expect(db.completeMessage).toHaveBeenCalledWith(
        MESSAGE_ID,
        expect.objectContaining({ outcome: 'kept', label: 'AI/WouldArchive' }),
      );
    });
  });

  describe('usage tracking', () => {
    it('records the usage of an LLM call', async () => {
      llmSays('action');

      await classifyEmail(MESSAGE_ID);

      expect(db.recordUsage).toHaveBeenCalledExactlyOnceWith(USAGE);
    });

    it('records nothing when a rule decides', async () => {
      vi.mocked(gmail.getEmail).mockResolvedValue(kbankSlip());

      await classifyEmail(MESSAGE_ID);

      expect(db.recordUsage).not.toHaveBeenCalled();
    });

    it('still counts a call whose email then fails to update', async () => {
      llmSays('action');
      vi.mocked(gmail.applyToThread).mockRejectedValue(new Error('gmail is down'));

      await expect(classifyEmail(MESSAGE_ID)).rejects.toThrow();

      expect(db.recordUsage).toHaveBeenCalledExactlyOnceWith(USAGE);
    });

    it('classifies the email even when recording usage fails', async () => {
      llmSays('action');
      vi.mocked(db.recordUsage).mockRejectedValue(new Error('firestore is down'));

      await expect(classifyEmail(MESSAGE_ID)).resolves.toMatchObject({ label: 'AI/Action' });
    });
  });

  describe('failures', () => {
    it('marks the message failed and rethrows so Pub/Sub retries', async () => {
      const error = new Error('gmail is down');
      llmSays('action');
      vi.mocked(gmail.applyToThread).mockRejectedValue(error);

      await expect(classifyEmail(MESSAGE_ID)).rejects.toThrow(error);

      expect(db.failMessage).toHaveBeenCalledWith(MESSAGE_ID, error);
      expect(db.completeMessage).not.toHaveBeenCalled();
    });
  });
});
