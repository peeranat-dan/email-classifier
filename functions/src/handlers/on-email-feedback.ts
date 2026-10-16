import * as logger from 'firebase-functions/logger';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';

import type { LabelChange } from '../services/gmail.js';

import { GMAIL_SECRETS, REGION, TOPICS } from '../config.js';
import { recordFeedback } from '../usecases/record-feedback.js';
import { isOlderThan, readJson } from './utils.js';

// Covers a classification that is still running; past that it is not coming
const MAX_RETRY_AGE_MS = 60 * 60_000;

export const onEmailFeedback = onMessagePublished(
  {
    topic: TOPICS.emailFeedback,
    region: REGION,
    secrets: GMAIL_SECRETS,
    retry: true,
    maxInstances: 2,
  },
  async (event) => {
    if (isOlderThan(event, MAX_RETRY_AGE_MS)) {
      logger.warn('Dropping label change after retry window', { eventId: event.id });
      return;
    }

    const change = readJson<LabelChange>(event);
    if (!change?.messageId || !Array.isArray(change.added) || !Array.isArray(change.removed)) {
      logger.warn('Ignoring invalid label change', { change });
      return;
    }

    const result = await recordFeedback(change);
    logger.info('Label change processed', { messageId: change.messageId, ...result });
  },
);
