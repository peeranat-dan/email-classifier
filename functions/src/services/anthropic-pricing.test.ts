import { describe, expect, it } from 'vitest';

import { estimateCostUsd } from './anthropic-pricing.js';

const tokens = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

describe('estimateCostUsd', () => {
  it('prices input and output tokens per million', () => {
    const cost = estimateCostUsd('claude-haiku-5-5', {
      ...tokens,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(0.1 + 0.5);
  });

  it('prices cache writes and reads at their own rates', () => {
    const cost = estimateCostUsd('claude-haiku-4-5', {
      ...tokens,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(1.25 + 0.1);
  });

  it('prices a dated snapshot like its alias', () => {
    const usage = { ...tokens, inputTokens: 500, outputTokens: 60 };

    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBe(
      estimateCostUsd('claude-haiku-4-5', usage),
    );
  });

  it('returns null for a model without a known price', () => {
    expect(estimateCostUsd('claude-unknown-9', { ...tokens, inputTokens: 100 })).toBeNull();
  });
});
