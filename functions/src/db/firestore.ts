import { FieldValue, getFirestore, type Timestamp } from 'firebase-admin/firestore';

import type { Usage } from '../services/anthropic.js';

const syncDoc = () => getFirestore().doc('sync/gmail');
const processedDoc = (id: string) => getFirestore().doc(`processed/${id}`);

const usageDoc = (day: string) => getFirestore().doc(`usage/${day}`);

export async function getHistoryId(): Promise<string | null> {
  const snap = await syncDoc().get();
  return snap.exists ? (snap.get('historyId') as string) : null;
}

export async function saveHistoryId(historyId: string): Promise<void> {
  await syncDoc().set({ historyId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

// Handler timeout is 120s, so an older claim means the instance died mid-flight
const STALE_CLAIM_MS = 5 * 60_000;
// Pub/Sub retry has no built-in cap, so count attempts per message
export const MAX_ATTEMPTS = 5;

export type ClaimResult = 'claimed' | 'duplicate' | 'exhausted';

export async function claimMessage(messageId: string): Promise<ClaimResult> {
  const ref = processedDoc(messageId);

  return getFirestore().runTransaction(async (tx): Promise<ClaimResult> => {
    const snap = await tx.get(ref);
    let attempts = 0;

    if (snap.exists) {
      const status = snap.get('status') as string;
      const createdAt = snap.get('createdAt') as Timestamp | undefined;
      attempts = (snap.get('attempts') as number | undefined) ?? 0;

      if (status === 'done') return 'duplicate';
      const inFlight =
        status === 'processing' &&
        createdAt !== undefined &&
        Date.now() - createdAt.toMillis() <= STALE_CLAIM_MS;
      if (inFlight) return 'duplicate';
      if (attempts >= MAX_ATTEMPTS) return 'exhausted';
    }

    tx.set(ref, {
      status: 'processing',
      attempts: attempts + 1,
      createdAt: FieldValue.serverTimestamp(),
    });
    return 'claimed';
  });
}

/** Also serves as the classification log for reviewing shadow mode. */
export async function completeMessage(
  messageId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await processedDoc(messageId).set(
    { status: 'done', ...result, doneAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/** Keeps the attempt count so the next delivery can be capped. */
export async function failMessage(messageId: string, err: unknown): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  await processedDoc(messageId).set({ status: 'failed', error }, { merge: true });
}

/** One processed/{messageId} document, as read back for the weekly summary. */
export interface ProcessedRecord {
  id: string;
  status: 'processing' | 'done' | 'failed';
  attempts?: number;
  outcome?: 'archived' | 'kept' | 'skipped';
  from?: string;
  subject?: string;
  label?: string;
  reason?: string;
  confidence?: number;
  error?: string;
}

/** Emails finished since `since`, plus every email currently failing. */
export async function listProcessedSince(since: Date): Promise<ProcessedRecord[]> {
  const processed = getFirestore().collection('processed');
  // Single-field filters, so neither query needs a composite index
  const [done, failed] = await Promise.all([
    processed.where('doneAt', '>=', since).get(),
    processed.where('status', '==', 'failed').get(),
  ]);

  return [...done.docs, ...failed.docs].map(
    (doc) => ({ id: doc.id, ...doc.data() }) as ProcessedRecord,
  );
}

/** Adds one LLM call to the day's totals. Days are UTC, like the Anthropic console. */
export async function recordUsage(usage: Usage): Promise<void> {
  const totals = {
    calls: FieldValue.increment(1),
    inputTokens: FieldValue.increment(usage.inputTokens),
    outputTokens: FieldValue.increment(usage.outputTokens),
    cacheWriteTokens: FieldValue.increment(usage.cacheWriteTokens),
    cacheReadTokens: FieldValue.increment(usage.cacheReadTokens),
    // A call without a known price is counted apart, so costUsd is never silently too low
    ...(usage.costUsd === null
      ? { unpricedCalls: FieldValue.increment(1) }
      : { costUsd: FieldValue.increment(usage.costUsd) }),
  };

  const day = new Date().toISOString().slice(0, 10);
  await usageDoc(day).set(
    { ...totals, byModel: { [usage.model]: totals }, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}
