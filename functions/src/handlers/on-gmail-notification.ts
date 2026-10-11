import * as logger from 'firebase-functions/logger';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';

import { GMAIL_SECRETS, params, REGION, TOPICS } from '../config.js';
import { processMailboxChange } from '../usecases/process-mailbox-change.js';
import { isOlderThan, readJson } from './utils.js';

// A newer notification re-syncs from the saved historyId, so old retries are safe to drop
const MAX_RETRY_AGE_MS = 60 * 60_000;

interface GmailPush {
  emailAddress?: string;
  historyId?: string | number;
}

export const onGmailNotification = onMessagePublished(
  {
    topic: TOPICS.gmailNotifications,
    region: REGION,
    secrets: GMAIL_SECRETS,
    retry: true,
    // historyId must advance one at a time
    maxInstances: 1,
    concurrency: 1,
  },
  async (event) => {
    if (isOlderThan(event, MAX_RETRY_AGE_MS)) {
      logger.warn('Dropping Gmail notification after retry window', { eventId: event.id });
      return;
    }

    const payload = readJson<GmailPush>(event);
    const expected = params.gmailAddress.value().toLowerCase();

    if (!payload?.historyId || payload.emailAddress?.toLowerCase() !== expected) {
      logger.warn('Ignoring invalid Gmail notification', { payload });
      return;
    }

    const result = await processMailboxChange(String(payload.historyId));
    logger.info('Mailbox change processed', result);
  },
);
