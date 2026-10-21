import type * as db from '../db/firestore.js';

/** How far back recommendations look; one week is too little to see a habit. */
export const HISTORY_WEEKS = 4;

/** A sender needs at least this many emails in the history before it gets a recommendation. */
const MIN_EMAILS = 4;
/** Share of a sender's kept mail that must land on one weekday to suggest checking it that day. */
const MIN_WEEKDAY_SHARE = 0.5;
const MAX_PER_KIND = 5;

/** Labels for mail that was, or in shadow mode would have been, archived. */
const ARCHIVE_LABELS = new Set([
  'Auto/Archived',
  'AI/Archived',
  'Auto/WouldArchive',
  'AI/WouldArchive',
]);
const RULE_LABELS = new Set(['Auto/Archived', 'Auto/WouldArchive']);

export interface Recommendation {
  action: string;
  why: string;
}

/** Suggestions from the senders' patterns in `records`, the most frequent sender first. */
export function recommend(records: db.ProcessedRecord[], timeZone: string): Recommendation[] {
  const bySender = new Map<string, db.ProcessedRecord[]>();
  for (const r of records) {
    if (r.status !== 'done' || !r.from || (r.outcome !== 'archived' && r.outcome !== 'kept')) {
      continue;
    }
    bySender.set(r.from, [...(bySender.get(r.from) ?? []), r]);
  }

  const byKind: Record<Kind, Scored[]> = { unsubscribe: [], addRule: [], checkOnDay: [] };
  for (const [from, mail] of bySender) {
    const found = recommendForSender(from, mail, timeZone);
    if (found) byKind[found.kind].push(found);
  }

  return Object.values(byKind).flatMap((kind) =>
    [...kind]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PER_KIND)
      .map(({ action, why }) => ({ action, why })),
  );
}

// ---- internals ----

/** In the order the summary lists them. */
type Kind = 'unsubscribe' | 'addRule' | 'checkOnDay';

interface Scored extends Recommendation {
  kind: Kind;
  score: number;
}

function recommendForSender(
  from: string,
  mail: db.ProcessedRecord[],
  timeZone: string,
): Scored | undefined {
  if (mail.length < MIN_EMAILS) return undefined;
  const archived = mail.filter((r) => r.label && ARCHIVE_LABELS.has(r.label));

  // Only a sender whose every email was junk; unsubscribing must not lose real mail
  if (archived.length === mail.length) {
    const known = `${mail.length} emails in the last ${HISTORY_WEEKS} weeks, all archived`;
    if (mail.some((r) => r.listUnsubscribe !== false)) {
      return {
        kind: 'unsubscribe',
        score: mail.length,
        action: `Unsubscribe from ${from}`,
        why: `${known}.`,
      };
    }
    if (mail.every((r) => r.label && RULE_LABELS.has(r.label))) return undefined;
    return {
      kind: 'addRule',
      score: mail.length,
      action: `Add a rule to archive mail from ${from}`,
      why: `${known}, with no unsubscribe link. A rule skips the Claude call.`,
    };
  }

  const kept = mail.filter((r) => !archived.includes(r) && r.doneAt);
  if (kept.length < MIN_EMAILS) return undefined;
  const [day, count] = busiestWeekday(kept, timeZone);
  if (count / kept.length < MIN_WEEKDAY_SHARE) return undefined;
  return {
    kind: 'checkOnDay',
    score: count,
    action: `Check ${from} on ${day}s`,
    why: `${count} of its ${kept.length} kept emails in the last ${HISTORY_WEEKS} weeks arrived on a ${day}.`,
  };
}

function busiestWeekday(records: db.ProcessedRecord[], timeZone: string): [string, number] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const day = r.doneAt!.toLocaleDateString('en-GB', { weekday: 'long', timeZone });
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts].reduce<[string, number]>(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ['', 0],
  );
}
