import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { params } from '../config.js';
import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import { HISTORY_WEEKS, type Recommendation, recommend } from './recommendations.js';

/** The classifier skips mail from the mailbox itself with this subject prefix. */
export const SUMMARY_SUBJECT_PREFIX = '[email-classifier] Weekly summary';

export const SUMMARY_TIME_ZONE = 'Asia/Bangkok';

const WEEK_MS = 7 * 24 * 60 * 60_000;

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
  const since = new Date(now.getTime() - WEEK_MS);
  const history = await db.listProcessedSince(new Date(now.getTime() - HISTORY_WEEKS * WEEK_MS));
  const week = history.filter((r) => r.status === 'failed' || (r.doneAt && r.doneAt >= since));
  const summary = buildSummary(week, { since, until: now }, recommend(history, SUMMARY_TIME_ZONE));
  const messageId = await gmail.insertIntoInbox(summary);
  return { messageId, ...summary.counts };
}

interface Period {
  since: Date;
  until: Date;
}

export function buildSummary(
  records: db.ProcessedRecord[],
  period: Period,
  recommendations: Recommendation[] = [],
) {
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

  const html = render(layout, {
    subject: escapeHtml(subject),
    preheader: escapeHtml(
      `${counts.archived} archived, ${counts.kept} kept, ${recommendations.length} recommended actions`,
    ),
    range: escapeHtml(range),
    headline: escapeHtml(
      `${counts.archived} archived, ${counts.kept} kept in the inbox, ` +
        `${counts.ignored} left untouched, ${counts.failed} failed.`,
    ),
    stats: OUTCOMES.map(({ key, label, color }) =>
      render(blocks.stat, { value: String(counts[key]), label, color }),
    ).join(''),
    bar: bar(counts),
    sections: [
      recommendationSection(recommendations),

      section('Archived', OUTCOME_COLORS.archived, counts.archived, [
        group(
          'Archived by a rule',
          archived.filter((r) => r.label === 'Auto/Archived'),
        ),
        group(
          'Archived by Claude',
          archived.filter((r) => r.label !== 'Auto/Archived'),
        ),
      ]),

      section('Kept in the inbox', OUTCOME_COLORS.kept, counts.kept, [
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

      section('Left untouched by an ignore rule', OUTCOME_COLORS.ignored, counts.ignored, [
        group('', ignored),
      ]),

      section('Could not be classified', OUTCOME_COLORS.failed, counts.failed, [
        group(
          'Gave up after the maximum attempts',
          failed.filter((r) => (r.attempts ?? 0) >= db.MAX_ATTEMPTS),
        ),
        group(
          'Still retrying',
          failed.filter((r) => (r.attempts ?? 0) < db.MAX_ATTEMPTS),
        ),
      ]),
    ].join('\n'),
  });

  return { subject, html, counts };
}

// ---- internals ----

type Counts = Record<'archived' | 'kept' | 'ignored' | 'failed', number>;

const OUTCOME_COLORS: Record<keyof Counts, string> = {
  archived: '#3f6b5c',
  kept: '#c7832b',
  ignored: '#b8b0a3',
  failed: '#b4442f',
};

/** The stat tiles and bar segments, left to right. */
const OUTCOMES: { key: keyof Counts; label: string; color: string }[] = [
  { key: 'archived', label: 'Archived', color: OUTCOME_COLORS.archived },
  { key: 'kept', label: 'Kept', color: OUTCOME_COLORS.kept },
  { key: 'ignored', label: 'Ignored', color: OUTCOME_COLORS.ignored },
  { key: 'failed', label: 'Failed', color: OUTCOME_COLORS.failed },
];

const RECOMMENDATION_COLOR = '#1c1917';

/** The template's layout, with each block cut out into `blocks`. */
const { layout, blocks } = parseTemplate(
  readFileSync(join(__dirname, '../../templates/weekly-summary.html'), 'utf8'),
);

function parseTemplate(template: string) {
  const blocks: Record<string, string> = {};
  const layout = template.replace(
    /[ \t]*<!-- block:([\w-]+) -->\n?([\s\S]*?)[ \t]*<!-- \/block:\1 -->\n?/g,
    (_, name: string, body: string) => {
      blocks[name] = body;
      return '';
    },
  );
  // The template's notes are for whoever edits it, not for the email
  return { layout: layout.replace(/[ \t]*<!--[\s\S]*?-->\n?/g, ''), blocks };
}

/** Fills each {{name}} in `template`; values must already be HTML-escaped. */
function render(template: string | undefined, values: Record<string, string>): string {
  if (template === undefined) throw new Error('Missing block in weekly-summary.html');
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function bar(counts: Counts): string {
  const total = OUTCOMES.reduce((sum, { key }) => sum + counts[key], 0);
  return OUTCOMES.filter(({ key }) => counts[key] > 0)
    .map(({ key, color }) =>
      render(blocks['bar-segment'], {
        width: String(Math.round((counts[key] / total) * 1000) / 10),
        color,
      }),
    )
    .join('');
}

function section(title: string, accent: string, count: number, parts: string[]): string {
  const body = parts.filter(Boolean).join('\n');
  return render(blocks.section, {
    title: escapeHtml(title),
    accent,
    count: String(count),
    body: body || render(blocks.empty, {}),
  });
}

function recommendationSection(recommendations: Recommendation[]): string {
  return section(
    'Recommended actions',
    RECOMMENDATION_COLOR,
    recommendations.length,
    recommendations.map((r) =>
      render(blocks.recommendation, { action: escapeHtml(r.action), why: escapeHtml(r.why) }),
    ),
  );
}

function group(title: string, records: db.ProcessedRecord[]): string {
  if (records.length === 0) return '';
  const heading = title
    ? render(blocks['group-heading'], { title: escapeHtml(title), count: String(records.length) })
    : '';
  const items = records
    .map((r) => {
      const link = `https://mail.google.com/mail/?authuser=${encodeURIComponent(
        params.gmailAddress.value(),
      )}#all/${encodeURIComponent(r.id)}`;
      const why = r.status === 'failed' ? r.error : r.reason;
      const confidence =
        r.confidence === undefined
          ? ''
          : render(blocks.confidence, { value: escapeHtml(String(r.confidence)) });
      return render(blocks.item, {
        link: escapeHtml(link),
        subject: escapeHtml(r.subject || '(no subject)'),
        from: escapeHtml(r.from || 'unknown sender'),
        details: why ? render(blocks.details, { why: escapeHtml(why), confidence }) : '',
      });
    })
    .join('');
  return heading + render(blocks.list, { items });
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
