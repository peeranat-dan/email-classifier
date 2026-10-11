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

export function matchRule(email: { fromAddress: string; subject: string }): Rule | undefined {
  return RULES.find(
    (rule) =>
      (rule.from || rule.subject) &&
      (!rule.from || rule.from.test(email.fromAddress)) &&
      (!rule.subject || rule.subject.test(email.subject)),
  );
}
