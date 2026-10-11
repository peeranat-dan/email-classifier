import { projectID } from 'firebase-functions/params';

import { TOPICS } from '../config.js';
import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';

export async function renewWatch() {
  const topic = `projects/${projectID.value()}/topics/${TOPICS.gmailNotifications}`;
  const result = await gmail.watch(topic);

  // Only set on first run; never skip changes that haven't been synced yet
  if (!(await db.getHistoryId())) {
    await db.saveHistoryId(result.historyId);
  }

  return result;
}
