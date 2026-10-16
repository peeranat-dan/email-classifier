import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import { recordFeedback } from './record-feedback.js';

vi.mock('../db/firestore.js');
vi.mock('../services/gmail.js');

const MESSAGE_ID = 'msg-1';

function processed(overrides: Partial<db.ProcessedMessage> = {}): db.ProcessedMessage {
  return {
    status: 'done',
    outcome: 'archived',
    source: 'llm',
    label: 'AI/Archived',
    archive: true,
    from: 'news@shop.example',
    subject: 'Big sale',
    ...overrides,
  };
}

const kept = (overrides: Partial<db.ProcessedMessage> = {}) =>
  processed({ outcome: 'kept', label: 'AI/Read', archive: false, ...overrides });

const change = (added: string[], removed: string[] = []): gmail.LabelChange => ({
  messageId: MESSAGE_ID,
  added,
  removed,
});

beforeEach(() => {
  vi.mocked(db.getProcessed).mockResolvedValue(processed());
  vi.mocked(db.recordFeedback).mockResolvedValue(true);
  // User label ids resolve to names; system ids stay as they are
  vi.mocked(gmail.getLabelNames).mockImplementation(async (ids) =>
    ids.map((id) => ({ Label_1: 'AI/Action', Label_2: 'AI/Archived' })[id] ?? id),
  );
});

describe('recordFeedback', () => {
  describe('changes made by this service', () => {
    it('ignores its own archive: label added, INBOX and UNREAD removed', async () => {
      const result = await recordFeedback(change(['Label_2'], ['INBOX', 'UNREAD']));

      expect(result).toEqual({ status: 'no-signal' });
      expect(db.recordFeedback).not.toHaveBeenCalled();
    });

    it('waits for a classification that is still applying its changes', async () => {
      vi.mocked(db.getProcessed).mockResolvedValue({ status: 'processing' });

      await expect(recordFeedback(change(['INBOX']))).rejects.toThrow('not finished');
    });
  });

  describe('mail this service did not triage', () => {
    it.each([
      ['never processed', null],
      ['skipped', processed({ outcome: 'skipped' })],
    ])('ignores mail it %s', async (_, doc) => {
      vi.mocked(db.getProcessed).mockResolvedValue(doc);

      await expect(recordFeedback(change(['INBOX']))).resolves.toEqual({ status: 'ignored' });
      expect(db.recordFeedback).not.toHaveBeenCalled();
    });
  });

  describe('corrections by the user', () => {
    it('learns "keep" when archived mail is moved back to the inbox', async () => {
      await expect(recordFeedback(change(['INBOX']))).resolves.toMatchObject({
        status: 'recorded',
        corrected: 'keep',
      });

      expect(db.recordFeedback).toHaveBeenCalledWith(
        {
          messageId: MESSAGE_ID,
          from: 'news@shop.example',
          subject: 'Big sale',
          predicted: 'AI/Archived',
          source: 'llm',
          corrected: 'keep',
          signal: 'moved back to inbox',
        },
        { sender: 'news@shop.example', domain: 'shop.example' },
      );
    });

    it('learns from a correction label you add', async () => {
      await expect(recordFeedback(change(['Label_1']))).resolves.toMatchObject({
        corrected: 'action',
        signal: 'added AI/Action',
      });
    });

    it('learns "archive" when kept mail is archived while still unread', async () => {
      vi.mocked(db.getProcessed).mockResolvedValue(kept());
      vi.mocked(gmail.getEmail).mockResolvedValue({
        id: MESSAGE_ID,
        fromAddress: 'news@shop.example',
        subject: 'Big sale',
        snippet: '',
        labelIds: ['UNREAD'],
        hasListUnsubscribe: true,
      });

      await expect(recordFeedback(change([], ['INBOX']))).resolves.toMatchObject({
        corrected: 'archive',
        signal: 'archived without reading',
      });
    });

    it('does not learn from archiving after reading, the normal inbox zero flow', async () => {
      vi.mocked(db.getProcessed).mockResolvedValue(kept());
      vi.mocked(gmail.getEmail).mockResolvedValue({
        id: MESSAGE_ID,
        fromAddress: 'news@shop.example',
        subject: 'Big sale',
        snippet: '',
        labelIds: [],
        hasListUnsubscribe: true,
      });

      await expect(recordFeedback(change([], ['INBOX']))).resolves.toEqual({
        status: 'no-signal',
      });
    });

    it.each([
      ['TRASH', 'deleted'],
      ['SPAM', 'spam'],
    ])('learns "archive" when kept mail goes to %s', async (label, signal) => {
      vi.mocked(db.getProcessed).mockResolvedValue(kept());

      await expect(recordFeedback(change([label], ['INBOX']))).resolves.toMatchObject({
        corrected: 'archive',
        signal,
      });
    });

    it('reports a correction it already stored as a duplicate', async () => {
      vi.mocked(db.recordFeedback).mockResolvedValue(false);

      await expect(recordFeedback(change(['INBOX']))).resolves.toMatchObject({
        status: 'duplicate',
      });
    });
  });
});
