import type { CloudEvent } from 'firebase-functions/v2';
import type { MessagePublishedData } from 'firebase-functions/v2/pubsub';

/** Returns null for non-JSON payloads, so the handler can ack instead of retrying forever. */
export function readJson<T>(event: CloudEvent<MessagePublishedData>): T | null {
  try {
    return event.data.message.json as T;
  } catch {
    return null;
  }
}

/** Lets a handler ack an old, repeatedly failing delivery instead of retrying it forever. */
export function isOlderThan(event: CloudEvent<MessagePublishedData>, maxAgeMs: number): boolean {
  const published = Date.parse(event.time);
  return Number.isFinite(published) && Date.now() - published > maxAgeMs;
}
