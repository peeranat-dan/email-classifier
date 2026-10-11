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

  const changes = await gmail.listInboxAdditions(lastHistoryId);

  if (!changes) {
    // lastHistoryId too old for Gmail; restart from here
    await db.saveHistoryId(notifiedHistoryId);
    return { queued: 0, note: 'resynced' };
  }

  // Publish before saving: a crash means duplicates (handled), never lost emails
  await pubsub.publishClassifyRequests(changes.messageIds);
  await db.saveHistoryId(changes.latestHistoryId);

  return { queued: changes.messageIds.length };
}
