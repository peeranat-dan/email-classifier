import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { GMAIL_SECRETS, REGION } from '../config.js';
import { sendWeeklySummary, SUMMARY_TIME_ZONE } from '../usecases/weekly-summary.js';

// Covers the 7 days before each run
export const onWeeklySummary = onSchedule(
  {
    schedule: 'every sunday 18:00',
    timeZone: SUMMARY_TIME_ZONE,
    region: REGION,
    secrets: GMAIL_SECRETS,
    retryCount: 3,
  },
  async () => {
    const result = await sendWeeklySummary();
    logger.info('Weekly summary sent', result);
  },
);
