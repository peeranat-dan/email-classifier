import { params } from '../config.js';
import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';

/** The classifier skips mail from the mailbox itself with this subject prefix. */
export const SUMMARY_SUBJECT_PREFIX = '[email-classifier] Weekly summary';

export const SUMMARY_TIME_ZONE = 'Asia/Bangkok';

const PERIOD_MS = 7 * 24 * 60 * 60_000;

/** Why an email was kept in the inbox, in the order the summary lists them. */
const KEPT_REASONS: Record<string, string> = {
  'AI/Action': 'Needs action',
  'AI/Read': 'Worth reading',
  'AI/Unsure': 'Claude was not confident enough to archive',
  'Auto/Protected': 'Protected sender (NEVER_ARCHIVE)',
  'AI/WouldArchive': 'Claude would archive (shadow mode)',
  'Auto/WouldArchive': 'A rule would archive (shadow mode)',
};

export async function sendWeeklySummary(now = new Date()) {
  const since = new Date(now.getTime() - PERIOD_MS);
  const records = await db.listProcessedSince(since);
  const summary = buildSummary(records, { since, until: now });
  const messageId = await gmail.insertIntoInbox(summary);
  return { messageId, ...summary.counts };
}

interface Period {
  since: Date;
  until: Date;
}

export function buildSummary(records: db.ProcessedRecord[], period: Period) {
  const archived = records.filter((r) => r.status === 'done' && r.outcome === 'archived');
  const kept = records.filter((r) => r.status === 'done' && r.outcome === 'kept');
  // Skipped mail without a sender left the inbox before we saw it, or is a previous summary
  const ignored = records.filter((r) => r.status === 'done' && r.outcome === 'skipped' && r.from);
  const failed = records.filter((r) => r.status === 'failed');

  const counts = {
    archived: archived.length,
    kept: kept.length,
    ignored: ignored.length,
    failed: failed.length,
  };
  const range = `${formatDate(period.since)} - ${formatDate(period.until)}`;
  const subject = `${SUMMARY_SUBJECT_PREFIX}: ${counts.archived} archived, ${counts.kept} kept (${range})`;

  const html = [
    `<h2>Inbox triage, ${escapeHtml(range)}</h2>`,
    `<p>${counts.archived} archived, ${counts.kept} kept in the inbox, ` +
      `${counts.ignored} left untouched, ${counts.failed} failed.</p>`,

    section(`Archived (${counts.archived})`, [
      group(
        'Archived by a rule',
        archived.filter((r) => r.label === 'Auto/Archived'),
      ),
      group(
        'Archived by Claude',
        archived.filter((r) => r.label !== 'Auto/Archived'),
      ),
    ]),

    section(`Kept in the inbox (${counts.kept})`, [
      ...Object.entries(KEPT_REASONS).map(([label, why]) =>
        group(
          why,
          kept.filter((r) => r.label === label),
        ),
      ),
      group(
        'Other',
        kept.filter((r) => !r.label || !(r.label in KEPT_REASONS)),
      ),
    ]),

    section(`Left untouched by an ignore rule (${counts.ignored})`, [group('', ignored)]),

    section(`Could not be classified (${counts.failed})`, [
      group(
        'Gave up after the maximum attempts',
        failed.filter((r) => (r.attempts ?? 0) >= db.MAX_ATTEMPTS),
      ),
      group(
        'Still retrying',
        failed.filter((r) => (r.attempts ?? 0) < db.MAX_ATTEMPTS),
      ),
    ]),
  ].join('\n');

  return { subject, html, counts };
}

function section(title: string, groups: string[]): string {
  const body = groups.filter(Boolean).join('\n');
  return `<h3>${escapeHtml(title)}</h3>\n${body || '<p>None.</p>'}`;
}

function group(title: string, records: db.ProcessedRecord[]): string {
  if (records.length === 0) return '';
  const heading = title ? `<h4>${escapeHtml(title)} (${records.length})</h4>\n` : '';
  const rows = records
    .map((r) => {
      const link = `https://mail.google.com/mail/?authuser=${encodeURIComponent(
        params.gmailAddress.value(),
      )}#all/${encodeURIComponent(r.id)}`;
      const why = r.status === 'failed' ? r.error : r.reason;
      const confidence = r.confidence === undefined ? '' : ` (confidence ${r.confidence})`;
      return (
        `<li><a href="${escapeHtml(link)}">${escapeHtml(r.subject || '(no subject)')}</a>` +
        ` from ${escapeHtml(r.from || 'unknown sender')}` +
        (why ? `<br><small>${escapeHtml(why + confidence)}</small>` : '') +
        `</li>`
      );
    })
    .join('\n');
  return `${heading}<ul>\n${rows}\n</ul>`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: SUMMARY_TIME_ZONE,
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
