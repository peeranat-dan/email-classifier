import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import * as pubsub from '../services/pubsub.js';

export async function processMailboxChange(notifiedHistoryId: string) {
  const lastHistoryId = await db.getHistoryId();

  if (!lastHistoryId) {
    await db.saveHistoryId(notifiedHistoryId);
    return { queued: 0, note: 'initialized' };
  }

  // Out-of-order notification; already covered by an earlier sync
  if (BigInt(notifiedHistoryId) <= BigInt(lastHistoryId)) {
    return { queued: 0, note: 'stale' };
  }

  const changes = await gmail.listChanges(lastHistoryId);

  if (!changes) {
    // lastHistoryId too old for Gmail; restart from here
    await db.saveHistoryId(notifiedHistoryId);
    return { queued: 0, note: 'resynced' };
  }

  // A new message's own label changes are this service classifying it, not feedback
  const added = new Set(changes.messageIds);
  const labelChanges = changes.labelChanges.filter(
    (c) => !added.has(c.messageId) && isPossibleFeedback(c),
  );

  // Publish before saving: a crash means duplicates (handled), never lost emails
  await Promise.all([
    pubsub.publishClassifyRequests(changes.messageIds),
    pubsub.publishLabelChanges(labelChanges),
  ]);
  await db.saveHistoryId(changes.latestHistoryId);

  return { queued: changes.messageIds.length, labelChanges: labelChanges.length };
}

/** Reading, starring or Gmail's own categories say nothing about the triage decision. */
function isPossibleFeedback(change: gmail.LabelChange): boolean {
  return (
    [...change.added, ...change.removed].some((id) => ['INBOX', 'TRASH', 'SPAM'].includes(id)) ||
    change.added.some((id) => id.startsWith('Label_')) // user labels, which include AI/*
  );
}
