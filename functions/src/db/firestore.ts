import { FieldValue, getFirestore, type Timestamp } from 'firebase-admin/firestore';

import type { Correction, FeedbackExample, LearnedHistory, Usage } from '../services/anthropic.js';

const syncDoc = () => getFirestore().doc('sync/gmail');
const processedDoc = (id: string) => getFirestore().doc(`processed/${id}`);

const usageDoc = (day: string) => getFirestore().doc(`usage/${day}`);
const feedbackDoc = (id: string) => getFirestore().doc(`feedback/${id}`);
// Addresses may hold characters a document id cannot, like '/'
const senderDoc = (address: string) => getFirestore().doc(`senders/${encodeURIComponent(address)}`);
const domainDoc = (domain: string) => getFirestore().doc(`domains/${encodeURIComponent(domain)}`);

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
const MAX_ATTEMPTS = 5;

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

/** What classify-email logged about a message, or null if it never got that far. */
export interface ProcessedMessage {
  status: 'processing' | 'done' | 'failed';
  outcome?: 'archived' | 'kept' | 'skipped';
  source?: 'protected' | 'rule' | 'learned' | 'llm';
  label?: string;
  archive?: boolean;
  from?: string;
  subject?: string;
}

export async function getProcessed(messageId: string): Promise<ProcessedMessage | null> {
  const snap = await processedDoc(messageId).get();
  return snap.exists ? (snap.data() as ProcessedMessage) : null;
}

export interface Feedback extends FeedbackExample {
  source: string;
  signal: string;
}

// Enough for the prompt to show a pattern, small enough to keep the call cheap
const MAX_EXAMPLES = 5;

/**
 * Stores the user's correction and folds it into the sender's (and domain's) history.
 * Returns false when the same correction was already recorded, e.g. a redelivery.
 */
export async function recordFeedback(
  feedback: Feedback,
  keys: { sender: string; domain: string | null },
): Promise<boolean> {
  const db = getFirestore();
  const ref = feedbackDoc(feedback.messageId);
  const historyRefs = [senderDoc(keys.sender), ...(keys.domain ? [domainDoc(keys.domain)] : [])];

  return db.runTransaction(async (tx) => {
    const [prev, ...histories] = await Promise.all([ref, ...historyRefs].map((r) => tx.get(r)));
    const previous = prev.exists ? (prev.get('corrected') as Correction) : undefined;
    if (previous === feedback.corrected) return false;

    const example: FeedbackExample = {
      messageId: feedback.messageId,
      from: feedback.from,
      subject: feedback.subject,
      predicted: feedback.predicted,
      corrected: feedback.corrected,
    };

    historyRefs.forEach((historyRef, i) => {
      const history = (histories[i].data() ?? {}) as Partial<LearnedHistory>;
      const counts = { ...history.counts };
      if (previous) counts[previous] = Math.max(0, (counts[previous] ?? 0) - 1);
      counts[feedback.corrected] = (counts[feedback.corrected] ?? 0) + 1;
      const examples = [
        example,
        ...(history.examples ?? []).filter((e) => e.messageId !== feedback.messageId),
      ].slice(0, MAX_EXAMPLES);
      tx.set(historyRef, { counts, examples, updatedAt: FieldValue.serverTimestamp() });
    });

    tx.set(ref, { ...feedback, correctedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export async function getLearnedHistory(keys: {
  sender: string;
  domain: string | null;
}): Promise<{ sender: LearnedHistory | null; domain: LearnedHistory | null }> {
  const [sender, domain] = await Promise.all([
    senderDoc(keys.sender).get(),
    keys.domain ? domainDoc(keys.domain).get() : null,
  ]);
  const read = (snap: typeof sender | null) =>
    snap?.exists ? (snap.data() as LearnedHistory) : null;
  return { sender: read(sender), domain: read(domain) };
}
