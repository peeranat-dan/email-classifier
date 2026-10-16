import { describe, expect, it } from 'vitest';

import { learningKeys, shouldAutoArchive } from './learning.js';

describe('learningKeys', () => {
  it('learns per sender and per domain', () => {
    expect(learningKeys('news@shop.example')).toEqual({
      sender: 'news@shop.example',
      domain: 'shop.example',
    });
  });

  it('skips the domain for public mail providers', () => {
    expect(learningKeys('friend@gmail.com')).toEqual({ sender: 'friend@gmail.com', domain: null });
  });
});

describe('shouldAutoArchive', () => {
  const history = (counts: Record<string, number>) => ({ counts, examples: [] });

  it('needs enough unread archives', () => {
    expect(shouldAutoArchive(history({ archive: 2 }))).toBe(false);
    expect(shouldAutoArchive(history({ archive: 3 }))).toBe(true);
  });

  it('never auto-archives a sender you have ever kept', () => {
    expect(shouldAutoArchive(history({ archive: 10, keep: 1 }))).toBe(false);
  });

  it('does nothing without history', () => {
    expect(shouldAutoArchive(null)).toBe(false);
  });
});
