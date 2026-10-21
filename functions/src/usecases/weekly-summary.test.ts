import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import { buildSummary, sendWeeklySummary } from './weekly-summary.js';

vi.mock('../config.js', () => ({
  params: { gmailAddress: { value: () => 'me@example.com' } },
}));
vi.mock('../db/firestore.js');
vi.mock('../services/gmail.js');

const PERIOD = {
  since: new Date('2026-10-04T11:00:00Z'),
  until: new Date('2026-10-11T11:00:00Z'),
};

function record(overrides: Partial<db.ProcessedRecord>): db.ProcessedRecord {
  return {
    id: 'msg-1',
    status: 'done',
    outcome: 'kept',
    from: 'friend@example.com',
    subject: 'Lunch on Friday?',
    ...overrides,
  };
}

/** The text of one section, up to the next section heading. */
function sectionOf(html: string, title: string): string {
  const start = html.indexOf(`<h3>${title}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('<h3>', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe('buildSummary', () => {
  it('counts each outcome in the subject', () => {
    const { subject, counts } = buildSummary(
      [
        record({ id: 'a', outcome: 'archived', label: 'Auto/Archived' }),
        record({ id: 'b', outcome: 'archived', label: 'AI/Archived' }),
        record({ id: 'c', outcome: 'kept', label: 'AI/Action' }),
      ],
      PERIOD,
    );

    expect(counts).toEqual({ archived: 2, kept: 1, ignored: 0, failed: 0 });
    expect(subject).toBe('[email-classifier] Weekly summary: 2 archived, 1 kept (4 Oct - 11 Oct)');
  });

  it('lists archived mail with why it was archived and a link to find it', () => {
    const { html } = buildSummary(
      [
        record({
          id: 'abc123',
          outcome: 'archived',
          label: 'AI/Archived',
          subject: 'Big sale',
          from: 'shop@example.com',
          reason: 'marketing',
          confidence: 0.95,
        }),
      ],
      PERIOD,
    );

    const archived = sectionOf(html, 'Archived');
    expect(archived).toContain('Archived by Claude (1)');
    expect(archived).toContain('Big sale');
    expect(archived).toContain('shop@example.com');
    expect(archived).toContain('marketing (confidence 0.95)');
    expect(archived).toContain(
      'href="https://mail.google.com/mail/?authuser=me%40example.com#all/abc123"',
    );
  });

  it('groups kept mail by why it was not archived', () => {
    const { html } = buildSummary(
      [
        record({ id: 'a', label: 'AI/Action', subject: 'Pay invoice' }),
        record({ id: 'b', label: 'AI/Unsure', subject: 'Maybe spam', confidence: 0.6 }),
        record({ id: 'c', label: 'Auto/Protected', subject: 'From mom' }),
      ],
      PERIOD,
    );

    const kept = sectionOf(html, 'Kept in the inbox');
    expect(kept).toMatch(/Needs action \(1\)[\s\S]*Pay invoice/);
    expect(kept).toMatch(/not confident enough to archive \(1\)[\s\S]*Maybe spam/);
    expect(kept).toMatch(/Protected sender \(NEVER_ARCHIVE\) \(1\)[\s\S]*From mom/);
    expect(kept).not.toContain('Worth reading');
  });

  it('lists ignored mail but not mail that left the inbox or earlier summaries', () => {
    const { html, counts } = buildSummary(
      [
        record({ id: 'a', outcome: 'skipped', subject: 'Agenda', reason: 'ignore: calendar' }),
        record({ id: 'b', outcome: 'skipped', from: undefined, subject: undefined }),
      ],
      PERIOD,
    );

    expect(counts.ignored).toBe(1);
    expect(sectionOf(html, 'Left untouched')).toContain('Agenda');
  });

  it('separates failed mail that was given up on from mail still retrying', () => {
    const { html } = buildSummary(
      [
        record({ id: 'a', status: 'failed', attempts: 5, error: 'gmail is down' }),
        record({ id: 'b', status: 'failed', attempts: 2, error: 'timeout' }),
      ],
      PERIOD,
    );

    const failed = sectionOf(html, 'Could not be classified');
    expect(failed).toMatch(/Gave up after the maximum attempts \(1\)[\s\S]*gmail is down/);
    expect(failed).toMatch(/Still retrying \(1\)[\s\S]*timeout/);
  });

  it('escapes HTML in subjects and senders', () => {
    const { html } = buildSummary([record({ subject: '<script>x</script> & "hi"' })], PERIOD);

    expect(html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; &quot;hi&quot;');
    expect(html).not.toContain('<script>');
  });

  it('lists recommended actions first, before the triage sections', () => {
    const { html } = buildSummary([], PERIOD, [
      { action: 'Unsubscribe from <news>@example.com', why: '4 emails, all archived.' },
    ]);

    const recommended = sectionOf(html, 'Recommended actions');
    expect(recommended).toContain('Recommended actions (1)');
    expect(recommended).toContain('Unsubscribe from &lt;news&gt;@example.com');
    expect(recommended).toContain('4 emails, all archived.');
    expect(html.indexOf('Recommended actions')).toBeLessThan(html.indexOf('<h3>Archived'));
  });

  it('says None for an empty section', () => {
    const { html } = buildSummary([], PERIOD);

    expect(sectionOf(html, 'Archived')).toContain('None.');
    expect(sectionOf(html, 'Recommended actions')).toContain('None.');
  });
});

describe('sendWeeklySummary', () => {
  const lastWeek = new Date('2026-10-08T03:00:00Z');
  const threeWeeksAgo = new Date('2026-09-22T03:00:00Z');
  const news = (id: string, doneAt: Date) =>
    record({ id, outcome: 'archived', label: 'AI/Archived', from: 'news@example.com', doneAt });

  beforeEach(() => {
    vi.mocked(db.listProcessedSince).mockResolvedValue([
      news('a', lastWeek),
      news('b', threeWeeksAgo),
      news('c', threeWeeksAgo),
      news('d', threeWeeksAgo),
      record({ id: 'e', status: 'failed', attempts: 1, error: 'timeout' }),
    ]);
    vi.mocked(gmail.insertIntoInbox).mockResolvedValue('summary-1');
  });

  it('summarizes the last 7 days and recommends from the last 4 weeks', async () => {
    await expect(sendWeeklySummary(PERIOD.until)).resolves.toEqual({
      messageId: 'summary-1',
      archived: 1,
      kept: 0,
      ignored: 0,
      failed: 1,
    });

    expect(db.listProcessedSince).toHaveBeenCalledWith(new Date('2026-09-13T11:00:00Z'));
    const { subject, html } = vi.mocked(gmail.insertIntoInbox).mock.calls[0][0];
    expect(subject).toContain('1 archived');
    expect(sectionOf(html, 'Recommended actions')).toContain('Unsubscribe from news@example.com');
  });
});
