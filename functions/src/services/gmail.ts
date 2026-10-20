import { auth, gmail as createGmail, type gmail_v1 } from '@googleapis/gmail';

import { params, secrets } from '../config.js';

export interface EmailSummary {
  id: string;
  threadId: string;
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

/** null when startHistoryId is too old for Gmail to replay. */
export async function listInboxAdditions(
  startHistoryId: string,
): Promise<{ messageIds: string[]; latestHistoryId: string } | null> {
  const messageIds = new Set<string>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  try {
    do {
      const res = await gmail().users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        pageToken,
      });

      for (const record of res.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const msg = added.message;
          if (msg?.id && msg.labelIds?.includes('INBOX')) messageIds.add(msg.id);
        }
      }

      latestHistoryId = res.data.historyId ?? latestHistoryId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (isStatus(err, 404)) return null;
    throw err;
  }

  return { messageIds: [...messageIds], latestHistoryId };
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
      threadId: res.data.threadId ?? messageId,
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

export interface ThreadChanges {
  addLabels: string[];
  /** Taken off every message in the thread; labels that do not exist yet are ignored. */
  removeLabels: string[];
  archive: boolean;
  markRead: boolean;
}

/** One atomic modify call over every message in the thread: label, archive and mark-read together. */
export async function applyToThread(threadId: string, changes: ThreadChanges): Promise<void> {
  const addLabelIds = await Promise.all(changes.addLabels.map(getOrCreateLabelId));
  const removeLabelIds = [
    ...(await findLabelIds(changes.removeLabels)).filter((id) => !addLabelIds.includes(id)),
    ...(changes.archive ? ['INBOX'] : []),
    ...(changes.markRead ? ['UNREAD'] : []),
  ];
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;

  await gmail().users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { addLabelIds, removeLabelIds },
  });
}

export interface OutgoingEmail {
  subject: string;
  html: string;
}

/**
 * Puts an email from the mailbox to itself straight into the inbox, unread.
 * Insert needs no send scope and skips spam filtering. Returns the new message id.
 */
export async function insertIntoInbox(email: OutgoingEmail): Promise<string> {
  const address = params.gmailAddress.value();
  const body = Buffer.from(email.html, 'utf8')
    .toString('base64')
    .replace(/.{76}(?=.)/g, '$&\r\n');
  const mime = [
    `From: email-classifier <${address}>`,
    `To: ${address}`,
    `Subject: ${email.subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');

  const res = await gmail().users.messages.insert({
    userId: 'me',
    internalDateSource: 'dateHeader',
    requestBody: {
      raw: Buffer.from(mime, 'utf8').toString('base64url'),
      labelIds: ['INBOX', 'UNREAD'],
    },
  });
  return res.data.id!;
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

/** Ids of the labels that exist; missing ones are left out rather than created. */
async function findLabelIds(names: string[]): Promise<string[]> {
  const missing = names.filter((name) => !labelIdCache.has(name));
  if (missing.length > 0) {
    const res = await gmail().users.labels.list({ userId: 'me' });
    for (const label of res.data.labels ?? []) {
      if (label.name && label.id && missing.includes(label.name)) cacheLabel(label.name, label.id);
    }
  }
  return names.flatMap((name) => labelIdCache.get(name) ?? []);
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
