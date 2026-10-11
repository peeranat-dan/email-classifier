import * as logger from 'firebase-functions/logger';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';

import { GMAIL_SECRETS, REGION, secrets, TOPICS } from '../config.js';
import { classifyEmail } from '../usecases/classify-email.js';
import { readJson } from './utils.js';

export const onClassifyEmail = onMessagePublished(
  {
    topic: TOPICS.classifyEmail,
    region: REGION,
    secrets: [...GMAIL_SECRETS, secrets.anthropicApiKey],
    retry: true,
    maxInstances: 5, // caps parallel Haiku calls
    concurrency: 1,
    timeoutSeconds: 120,
  },
  async (event) => {
    const payload = readJson<{ messageId?: string }>(event);

    if (!payload?.messageId) {
      logger.warn('Ignoring invalid classify request', { payload });
      return;
    }

    const result = await classifyEmail(payload.messageId);
    if (result.status === 'exhausted') {
      logger.error('Giving up on email after max attempts', { messageId: payload.messageId });
      return;
    }
    logger.info('Email classified', { messageId: payload.messageId, ...result });
  },
);
