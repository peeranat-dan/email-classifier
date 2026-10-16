import type { Correction } from '../services/anthropic.js';

import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import { learningKeys } from './learning.js';

/** Labels you can put on an email to say what it should have been. */
const CORRECTION_LABELS: Record<string, Correction> = {
  'AI/Action': 'action',
  'AI/Read': 'important',
  'AI/Archived': 'archive',
};

interface Signal {
  corrected: Correction;
  signal: string;
}

/**
 * Turns a label change into a correction when it contradicts what this service did.
 *
 * Gmail does not say who made a change, and this service acts with your own OAuth token.
 * But it only touches a message once, in one modify call: it adds `label`, and removes
 * INBOX and UNREAD when it archives. Anything else (restoring to the inbox, archiving
 * or trashing mail it kept, adding a different label) can only have come from you.
 */
export async function recordFeedback(change: gmail.LabelChange) {
  const processed = await db.getProcessed(change.messageId);

  // Mail from before this service, or that it left alone
  if (!processed || processed.outcome === 'skipped') return { status: 'ignored' };
  // The classification may still be applying its own changes; Pub/Sub retries this
  if (processed.status !== 'done') throw new Error('Classification not finished yet');
  if (!processed.label || processed.archive === undefined || !processed.from) {
    return { status: 'ignored' };
  }

  const signal = await detect(change, processed as Required<db.ProcessedMessage>);
  if (!signal) return { status: 'no-signal' };

  const recorded = await db.recordFeedback(
    {
      messageId: change.messageId,
      from: processed.from,
      subject: processed.subject ?? '',
      predicted: processed.label,
      source: processed.source ?? 'unknown',
      ...signal,
    },
    learningKeys(processed.from),
  );
  return { status: recorded ? 'recorded' : 'duplicate', ...signal };
}

async function detect(
  change: gmail.LabelChange,
  processed: Required<db.ProcessedMessage>,
): Promise<Signal | null> {
  const added = await gmail.getLabelNames(change.added);
  const removed = new Set(change.removed);

  const relabel = added.find((name) => name in CORRECTION_LABELS && name !== processed.label);
  if (relabel) return { corrected: CORRECTION_LABELS[relabel], signal: `added ${relabel}` };

  if (processed.archive) {
    // This service never adds INBOX back
    if (added.includes('INBOX')) return { corrected: 'keep', signal: 'moved back to inbox' };
    return null;
  }

  // It was kept in the inbox, so removing INBOX is yours
  if (added.includes('TRASH') || added.includes('SPAM')) {
    return { corrected: 'archive', signal: added.includes('TRASH') ? 'deleted' : 'spam' };
  }
  if (removed.has('INBOX')) {
    // Inbox zero means you archive everything once read; only unread archiving says "noise"
    const email = await gmail.getEmail(change.messageId);
    if (email?.labelIds.includes('UNREAD')) {
      return { corrected: 'archive', signal: 'archived without reading' };
    }
  }
  return null;
}
