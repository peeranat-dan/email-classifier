export interface Rule {
  name: string;
  /** All specified fields must match. At least one is required. */
  from?: RegExp;
  subject?: RegExp;
}

/** Matching mail is labelled Auto/Archived, archived and marked read, with no LLM call. */
export const RULES: Rule[] = [
  {
    name: 'kbank-slip',
    from: /@kasikornbank\.com$/,
    subject: /Result of Bill Payment \(Success\)/i,
  },
];

/** Matching mail is left exactly as it arrived: no label, not marked read, no LLM call. */
export const IGNORE_RULES: Rule[] = [
  {
    name: 'google-calendar-notification',
    from: /^calendar-notification@google\.com$/,
  },
];

export function matchRule(
  email: { fromAddress: string; subject: string },
  rules: Rule[],
): Rule | undefined {
  return rules.find(
    (rule) =>
      (rule.from || rule.subject) &&
      (!rule.from || rule.from.test(email.fromAddress)) &&
      (!rule.subject || rule.subject.test(email.subject)),
  );
}
