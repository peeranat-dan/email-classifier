import { params } from '../config.js';
import * as db from '../db/firestore.js';
import * as anthropic from '../services/anthropic.js';
import * as gmail from '../services/gmail.js';
import { matchRule } from './rules.js';

/** Auto/* is decided without the LLM (rules, protected senders); AI/* is an LLM decision. */
const LABELS = {
  autoArchived: 'Auto/Archived',
  autoWouldArchive: 'Auto/WouldArchive',
  protected: 'Auto/Protected',
  action: 'AI/Action',
  read: 'AI/Read',
  archived: 'AI/Archived',
  unsure: 'AI/Unsure',
  wouldArchive: 'AI/WouldArchive',
} as const;

interface Decision {
  source: 'protected' | 'rule' | 'llm';
  label: string;
  archive: boolean;
  markRead: boolean;
  reason: string;
  confidence?: number;
}

export async function classifyEmail(messageId: string) {
  const claim = await db.claimMessage(messageId);
  if (claim !== 'claimed') {
    return { status: claim };
  }

  try {
    const email = await gmail.getEmail(messageId);

    if (!email || !email.labelIds.includes('INBOX')) {
      await db.completeMessage(messageId, { outcome: 'skipped' });
      return { status: 'skipped' };
    }

    const decision = applyShadowMode(await decide(email));

    await gmail.applyChanges(messageId, {
      addLabels: [decision.label],
      archive: decision.archive,
      markRead: decision.markRead,
    });

    await db.completeMessage(messageId, {
      from: email.fromAddress,
      subject: email.subject,
      outcome: decision.archive ? 'archived' : 'kept',
      ...decision,
    });
    return { status: 'done', ...decision };
  } catch (err) {
    await db.failMessage(messageId, err); // the retry may try again, up to the attempt cap
    throw err;
  }
}

async function decide(email: gmail.EmailSummary): Promise<Decision> {
  if (isProtectedSender(email.fromAddress)) {
    return {
      source: 'protected',
      label: LABELS.protected,
      archive: false,
      markRead: false,
      reason: 'protected sender',
    };
  }

  const rule = matchRule(email);
  if (rule) {
    return {
      source: 'rule',
      label: LABELS.autoArchived,
      archive: true,
      markRead: true,
      reason: `rule: ${rule.name}`,
    };
  }

  const result = await anthropic.classifyEmail(email);
  const base = { source: 'llm', reason: result.reason, confidence: result.confidence } as const;

  if (result.confidence < Number(params.minConfidence.value())) {
    return { ...base, label: LABELS.unsure, archive: false, markRead: false };
  }

  switch (result.category) {
    case 'action':
      return { ...base, label: LABELS.action, archive: false, markRead: false };
    case 'important':
      return { ...base, label: LABELS.read, archive: false, markRead: false };
    case 'archive':
      return { ...base, label: LABELS.archived, archive: true, markRead: false };
  }
}

/** In shadow mode archiving is only recorded as a label; the inbox is untouched. */
function applyShadowMode(decision: Decision): Decision {
  if (!decision.archive || !params.shadowMode.value()) return decision;
  const label = decision.source === 'llm' ? LABELS.wouldArchive : LABELS.autoWouldArchive;
  return { ...decision, label, archive: false, markRead: false };
}

function isProtectedSender(address: string): boolean {
  const addr = address.toLowerCase();
  return params.neverArchive.value().some((rule) => {
    const r = rule.trim().toLowerCase();
    return r.startsWith('@') ? addr.endsWith(r) : addr === r;
  });
}
