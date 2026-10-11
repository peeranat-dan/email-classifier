import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { GMAIL_SECRETS, REGION } from '../config.js';
import { renewWatch } from '../usecases/renew-watch.js';

// Watch expires after 7 days. Use "Force run" in Cloud Scheduler for first setup.
export const onRenewWatch = onSchedule(
  {
    schedule: 'every day 03:00',
    timeZone: 'Asia/Bangkok',
    region: REGION,
    secrets: GMAIL_SECRETS,
    retryCount: 3,
  },
  async () => {
    const result = await renewWatch();
    logger.info('Gmail watch renewed', { expiresAt: result.expiresAt.toISOString() });
  },
);
