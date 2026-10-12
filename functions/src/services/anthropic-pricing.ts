/** Token counts of one Messages API call, as billed. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

interface Price {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute cache writes, the only TTL this app could use
  cacheRead: number;
}

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// Haiku 5.5 costs 5x more for prompts over 100k tokens; ours are a few hundred.
const PRICING: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/** Returns null for a model without a known price, so an unpriced call never looks free. */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
  // Prefix match also covers dated snapshots such as claude-haiku-4-5-20251001
  const id = Object.keys(PRICING).find((known) => model.startsWith(known));
  if (!id) return null;

  const price = PRICING[id];
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheWriteTokens * price.cacheWrite +
      tokens.cacheReadTokens * price.cacheRead) /
    1_000_000
  );
}
