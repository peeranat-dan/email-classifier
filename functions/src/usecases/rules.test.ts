import { describe, expect, it } from 'vitest';

import { matchRule } from './rules.js';

const kbankSlip = {
  fromAddress: 'no-reply@kasikornbank.com',
  subject: 'Result of Bill Payment (Success)',
};

describe('matchRule', () => {
  it('matches a KBank bill payment slip', () => {
    expect(matchRule(kbankSlip)?.name).toBe('kbank-slip');
  });

  it('matches the subject case-insensitively and anywhere in the line', () => {
    const email = { ...kbankSlip, subject: 'FW: result of bill payment (success) #123' };

    expect(matchRule(email)?.name).toBe('kbank-slip');
  });

  it('needs every field of a rule to match, not just one', () => {
    expect(matchRule({ ...kbankSlip, subject: 'Your statement is ready' })).toBeUndefined();
    expect(matchRule({ ...kbankSlip, fromAddress: 'someone@gmail.com' })).toBeUndefined();
  });

  it('does not match a lookalike domain', () => {
    const email = { ...kbankSlip, fromAddress: 'no-reply@kasikornbank.com.evil.io' };

    expect(matchRule(email)).toBeUndefined();
  });
});
