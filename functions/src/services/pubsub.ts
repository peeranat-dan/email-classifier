import { PubSub, type Topic } from '@google-cloud/pubsub';

import type { LabelChange } from './gmail.js';

import { TOPICS } from '../config.js';

const topics = new Map<string, Topic>();

function topic(name: string): Topic {
  let t = topics.get(name);
  if (!t) topics.set(name, (t = new PubSub().topic(name)));
  return t;
}

export async function publishClassifyRequests(messageIds: string[]): Promise<void> {
  await Promise.all(
    messageIds.map((messageId) =>
      topic(TOPICS.classifyEmail).publishMessage({ json: { messageId } }),
    ),
  );
}

export async function publishLabelChanges(changes: LabelChange[]): Promise<void> {
  await Promise.all(
    changes.map((change) => topic(TOPICS.emailFeedback).publishMessage({ json: change })),
  );
}
