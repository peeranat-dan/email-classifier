import { auth, gmail as createGmail, type gmail_v1 } from '@googleapis/gmail';

import { params, secrets } from '../config.js';

export interface EmailSummary {
  id: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  labelIds: string[];
  hasListUnsubscribe: boolean;
}

// Lazy: secrets are only readable at runtime, and the client is reused per instance
let client: gmail_v1.Gmail | undefined;

function gmail(): gmail_v1.Gmail {
  if (!client) {
    const oauth = new auth.OAuth2(params.gmailClientId.value(), secrets.gmailClientSecret.value());
    oauth.setCredentials({ refresh_token: secrets.gmailRefreshToken.value() });
    client = createGmail({ version: 'v1', auth: oauth });
  }
  return client;
}

export async function watch(topicName: string): Promise<{ historyId: string; expiresAt: Date }> {
  const res = await gmail().users.watch({
    userId: 'me',
    requestBody: { topicName, labelIds: ['INBOX'] },
  });
  return {
    historyId: String(res.data.historyId),
    expiresAt: new Date(Number(res.data.expiration)),
  };
}

/** Net label changes on one message over a sync window. Label ids, not names. */
export interface LabelChange {
  messageId: string;
  added: string[];
  removed: string[];
}

export interface MailboxChanges {
  /** New messages that arrived in the inbox. */
  messageIds: string[];
  /** Label changes on any message, by the user or by this service. */
  labelChanges: LabelChange[];
  latestHistoryId: string;
}

/** null when startHistoryId is too old for Gmail to replay. */
export async function listChanges(startHistoryId: string): Promise<MailboxChanges | null> {
  const messageIds = new Set<string>();
  const labels = new Map<string, { added: Set<string>; removed: Set<string> }>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  // Records come oldest first, so a later change cancels an earlier opposite one
  const track = (id: string, labelIds: string[], added: boolean) => {
    const entry = labels.get(id) ?? { added: new Set<string>(), removed: new Set<string>() };
    labels.set(id, entry);
    for (const label of labelIds) {
      const [into, from] = added ? [entry.added, entry.removed] : [entry.removed, entry.added];
      if (!from.delete(label)) into.add(label);
    }
  };

  try {
    do {
      // No labelId filter: archiving or trashing removes INBOX, which a filter would hide
      const res = await gmail().users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
        pageToken,
      });

      for (const record of res.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const msg = added.message;
          if (msg?.id && msg.labelIds?.includes('INBOX')) messageIds.add(msg.id);
        }
        for (const change of record.labelsAdded ?? []) {
          if (change.message?.id) track(change.message.id, change.labelIds ?? [], true);
        }
        for (const change of record.labelsRemoved ?? []) {
          if (change.message?.id) track(change.message.id, change.labelIds ?? [], false);
        }
      }

      latestHistoryId = res.data.historyId ?? latestHistoryId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (isStatus(err, 404)) return null;
    throw err;
  }

  const labelChanges = [...labels]
    .map(([messageId, { added, removed }]) => ({
      messageId,
      added: [...added],
      removed: [...removed],
    }))
    .filter((c) => c.added.length > 0 || c.removed.length > 0);

  return { messageIds: [...messageIds], labelChanges, latestHistoryId };
}

/** null when the message was deleted before we got to it. */
export async function getEmail(messageId: string): Promise<EmailSummary | null> {
  try {
    const res = await gmail().users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'List-Unsubscribe'],
    });

    const headers = res.data.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

    return {
      id: messageId,
      fromAddress: extractAddress(header('From')),
      subject: header('Subject'),
      snippet: res.data.snippet ?? '',
      labelIds: res.data.labelIds ?? [],
      hasListUnsubscribe: header('List-Unsubscribe') !== '',
    };
  } catch (err) {
    if (isStatus(err, 404)) return null;
    throw err;
  }
}

export interface MessageChanges {
  addLabels: string[];
  archive: boolean;
  markRead: boolean;
}

/** One atomic modify call: label, archive and mark-read together. */
export async function applyChanges(messageId: string, changes: MessageChanges): Promise<void> {
  const addLabelIds = await Promise.all(changes.addLabels.map(getOrCreateLabelId));
  const removeLabelIds = [
    ...(changes.archive ? ['INBOX'] : []),
    ...(changes.markRead ? ['UNREAD'] : []),
  ];
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;

  await gmail().users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
}

// ---- internals ----

const labelIdCache = new Map<string, string>();

async function getOrCreateLabelId(name: string): Promise<string> {
  const cached = labelIdCache.get(name);
  if (cached) return cached;

  const existing = await findLabelId(name);
  if (existing) return cacheLabel(name, existing);

  try {
    const res = await gmail().users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    return cacheLabel(name, res.data.id!);
  } catch (err) {
    // Another instance created it at the same time
    if (isStatus(err, 409)) {
      const id = await findLabelId(name);
      if (id) return cacheLabel(name, id);
    }
    throw err;
  }
}

async function findLabelId(name: string): Promise<string | undefined> {
  const res = await gmail().users.labels.list({ userId: 'me' });
  return res.data.labels?.find((l) => l.name === name)?.id ?? undefined;
}

/** System labels (INBOX, TRASH, ...) keep their id; user labels are looked up. */
export async function getLabelNames(ids: string[]): Promise<string[]> {
  const known = () => new Map([...labelIdCache].map(([name, id]) => [id, name]));
  let names = known();
  if (ids.some((id) => id.startsWith('Label_') && !names.has(id))) {
    const res = await gmail().users.labels.list({ userId: 'me' });
    for (const l of res.data.labels ?? []) if (l.name && l.id) cacheLabel(l.name, l.id);
    names = known();
  }
  return ids.map((id) => names.get(id) ?? id);
}

function cacheLabel(name: string, id: string): string {
  labelIdCache.set(name, id);
  return id;
}

function extractAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim().toLowerCase();
}

function isStatus(err: unknown, status: number): boolean {
  const e = err as { status?: number; code?: number | string };
  return e?.status === status || Number(e?.code) === status;
}
