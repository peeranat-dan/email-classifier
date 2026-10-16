import type { LearnedHistory } from '../services/anthropic.js';

// Everyone shares these, so a domain-wide pattern would mix unrelated senders
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
]);

export function learningKeys(address: string): { sender: string; domain: string | null } {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return { sender: address, domain: domain && !PUBLIC_DOMAINS.has(domain) ? domain : null };
}

/** How many times you must archive a sender's mail unread before it skips the LLM. */
export const LEARNED_ARCHIVE_MIN = 3;

/** Archive without asking the LLM once you only ever threw this sender's mail away. */
export function shouldAutoArchive(sender: LearnedHistory | null): boolean {
  const { archive = 0, keep = 0, action = 0, important = 0 } = sender?.counts ?? {};
  return archive >= LEARNED_ARCHIVE_MIN && keep + action + important === 0;
}
