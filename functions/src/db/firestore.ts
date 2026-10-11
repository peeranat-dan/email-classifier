import { FieldValue, getFirestore, type Timestamp } from 'firebase-admin/firestore';

const syncDoc = () => getFirestore().doc('sync/gmail');
const processedDoc = (id: string) => getFirestore().doc(`processed/${id}`);

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
