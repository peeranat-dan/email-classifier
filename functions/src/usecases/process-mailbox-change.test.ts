import { describe, expect, it, vi } from 'vitest';

import * as db from '../db/firestore.js';
import * as gmail from '../services/gmail.js';
import * as pubsub from '../services/pubsub.js';
import { processMailboxChange } from './process-mailbox-change.js';

vi.mock('../db/firestore.js');
vi.mock('../services/gmail.js');
vi.mock('../services/pubsub.js');

describe('processMailboxChange', () => {
  it('only stores the history id on the very first notification', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue(null);

    await expect(processMailboxChange('100')).resolves.toEqual({ queued: 0, note: 'initialized' });

    expect(db.saveHistoryId).toHaveBeenCalledWith('100');
    expect(gmail.listInboxAdditions).not.toHaveBeenCalled();
  });

  it.each(['100', '99'])(
    'ignores a stale notification (%s when already at 100)',
    async (notified) => {
      vi.mocked(db.getHistoryId).mockResolvedValue('100');

      await expect(processMailboxChange(notified)).resolves.toEqual({ queued: 0, note: 'stale' });

      expect(gmail.listInboxAdditions).not.toHaveBeenCalled();
      expect(db.saveHistoryId).not.toHaveBeenCalled();
    },
  );

  it('compares history ids as numbers, not strings', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue('9');
    vi.mocked(gmail.listInboxAdditions).mockResolvedValue({
      messageIds: [],
      latestHistoryId: '10',
    });

    // '10' < '9' as strings, which would wrongly look stale
    await expect(processMailboxChange('10')).resolves.toEqual({ queued: 0 });
  });

  it('queues every new inbox message and advances to the latest history id', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue('100');
    vi.mocked(gmail.listInboxAdditions).mockResolvedValue({
      messageIds: ['a', 'b'],
      latestHistoryId: '105',
    });

    await expect(processMailboxChange('103')).resolves.toEqual({ queued: 2 });

    expect(gmail.listInboxAdditions).toHaveBeenCalledWith('100');
    expect(pubsub.publishClassifyRequests).toHaveBeenCalledWith(['a', 'b']);
    // Gmail's id, which can be ahead of the one in the notification
    expect(db.saveHistoryId).toHaveBeenCalledWith('105');
  });

  it('publishes before saving, so a failed publish is retried from the same point', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue('100');
    vi.mocked(gmail.listInboxAdditions).mockResolvedValue({
      messageIds: ['a'],
      latestHistoryId: '105',
    });
    vi.mocked(pubsub.publishClassifyRequests).mockRejectedValue(new Error('pubsub is down'));

    await expect(processMailboxChange('103')).rejects.toThrow('pubsub is down');

    expect(db.saveHistoryId).not.toHaveBeenCalled();
  });

  it('restarts from the notified id when Gmail can no longer replay the history', async () => {
    vi.mocked(db.getHistoryId).mockResolvedValue('100');
    vi.mocked(gmail.listInboxAdditions).mockResolvedValue(null);

    await expect(processMailboxChange('5000')).resolves.toEqual({ queued: 0, note: 'resynced' });

    expect(db.saveHistoryId).toHaveBeenCalledWith('5000');
    expect(pubsub.publishClassifyRequests).not.toHaveBeenCalled();
  });
});
