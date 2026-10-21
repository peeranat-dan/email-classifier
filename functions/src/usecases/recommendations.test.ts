import { describe, expect, it } from 'vitest';

import type * as db from '../db/firestore.js';

import { recommend } from './recommendations.js';

const TIME_ZONE = 'Asia/Bangkok';

// Mornings in Bangkok: 2026-10-06 is a Tuesday, 2026-10-07 a Wednesday
const TUESDAYS = ['2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06'];

function record(overrides: Partial<db.ProcessedRecord>): db.ProcessedRecord {
  return {
    id: 'msg',
    status: 'done',
    outcome: 'archived',
    label: 'AI/Archived',
    from: 'news@example.com',
    doneAt: new Date('2026-10-06T03:00:00Z'),
    ...overrides,
  };
}

const times = (n: number, overrides: Partial<db.ProcessedRecord>) =>
  Array.from({ length: n }, (_, i) => record({ id: `msg-${i}`, ...overrides }));

describe('recommend', () => {
  it('suggests unsubscribing from a sender whose every email was archived', () => {
    expect(recommend(times(4, {}), TIME_ZONE)).toEqual([
      {
        action: 'Unsubscribe from news@example.com',
        why: '4 emails in the last 4 weeks, all archived.',
      },
    ]);
  });

  it('counts shadow-mode would-archive mail as archived', () => {
    const records = times(4, { outcome: 'kept', label: 'AI/WouldArchive' });

    expect(recommend(records, TIME_ZONE)).toMatchObject([
      { action: 'Unsubscribe from news@example.com' },
    ]);
  });

  it('says nothing about a sender below the minimum', () => {
    expect(recommend(times(3, {}), TIME_ZONE)).toEqual([]);
  });

  it('does not suggest unsubscribing when some of the mail was kept', () => {
    const records = [...times(5, {}), record({ id: 'kept', outcome: 'kept', label: 'AI/Action' })];

    expect(recommend(records, TIME_ZONE)).toEqual([]);
  });

  it('suggests a rule instead when Claude archives mail with no unsubscribe link', () => {
    const records = times(4, { from: 'slips@bank.com', listUnsubscribe: false });

    expect(recommend(records, TIME_ZONE)).toEqual([
      {
        action: 'Add a rule to archive mail from slips@bank.com',
        why: '4 emails in the last 4 weeks, all archived, with no unsubscribe link. A rule skips the Claude call.',
      },
    ]);
  });

  it('says nothing when a rule already archives a sender with no unsubscribe link', () => {
    const records = times(4, { label: 'Auto/Archived', listUnsubscribe: false });

    expect(recommend(records, TIME_ZONE)).toEqual([]);
  });

  it('suggests checking a sender on the weekday most of its kept mail arrives', () => {
    const records = [
      ...TUESDAYS.map((day, i) =>
        record({
          id: `tue-${i}`,
          outcome: 'kept',
          label: 'AI/Read',
          from: 'notifications@github.com',
          doneAt: new Date(`${day}T03:00:00Z`),
        }),
      ),
      record({
        id: 'wed',
        outcome: 'kept',
        label: 'AI/Action',
        from: 'notifications@github.com',
        doneAt: new Date('2026-10-07T03:00:00Z'),
      }),
    ];

    expect(recommend(records, TIME_ZONE)).toEqual([
      {
        action: 'Check notifications@github.com on Tuesdays',
        why: '4 of its 5 kept emails in the last 4 weeks arrived on a Tuesday.',
      },
    ]);
  });

  it('uses the summary time zone to tell the weekday', () => {
    // 20:00 UTC Monday is 03:00 Tuesday in Bangkok
    const records = times(4, {
      outcome: 'kept',
      label: 'AI/Read',
      doneAt: new Date('2026-10-05T20:00:00Z'),
    });

    expect(recommend(records, TIME_ZONE)).toMatchObject([
      { action: 'Check news@example.com on Tuesdays' },
    ]);
  });

  it('says nothing when kept mail is spread across the week', () => {
    const records = ['05', '06', '07', '08'].map((d, i) =>
      record({
        id: `m-${i}`,
        outcome: 'kept',
        label: 'AI/Read',
        doneAt: new Date(`2026-10-${d}T03:00:00Z`),
      }),
    );

    expect(recommend(records, TIME_ZONE)).toEqual([]);
  });

  it('ignores skipped and failed mail', () => {
    const records = [
      ...times(2, {}),
      record({ id: 's', outcome: 'skipped' }),
      record({ id: 'f', status: 'failed' }),
    ];

    expect(recommend(records, TIME_ZONE)).toEqual([]);
  });

  it('lists unsubscribes before rules and weekdays, the most frequent sender first', () => {
    const records = [
      ...times(4, { from: 'a@example.com' }),
      ...times(6, { from: 'b@example.com' }),
      ...times(4, { from: 'slips@bank.com', listUnsubscribe: false }),
    ];

    expect(recommend(records, TIME_ZONE).map((r) => r.action)).toEqual([
      'Unsubscribe from b@example.com',
      'Unsubscribe from a@example.com',
      'Add a rule to archive mail from slips@bank.com',
    ]);
  });
});
