import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import { renewWatch } from './renew-watch.js';

vi.mock('../db/firestore.js');
vi.mock('../services/gmail.js');

const watchResult = { historyId: '200', expiresAt: new Date('2026-01-08T00:00:00Z') };

beforeEach(() => {
  // projectID param is read from here at runtime
  vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ projectId: 'demo-project' }));
  vi.mocked(gmail.watch).mockResolvedValue(watchResult);
});

describe('renewWatch', () => {
  it("points Gmail at this project's notification topic", async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue('100');

    await expect(renewWatch()).resolves.toEqual(watchResult);

    expect(gmail.watch).toHaveBeenCalledWith('projects/demo-project/topics/gmail-notifications');
  });

  it('stores the starting history id on the first run', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue(null);

    await renewWatch();

    expect(db.saveHistoryId).toHaveBeenCalledWith('200');
  });

  it('never overwrites an existing history id, which would skip unsynced mail', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue('100');

    await renewWatch();

    expect(db.saveHistoryId).not.toHaveBeenCalled();
  });
});
