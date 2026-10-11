import { PubSub, type Topic } from '@google-cloud/pubsub';

import { TOPICS } from '../config.js';

let topic: Topic | undefined;

function classifyTopic(): Topic {
  return (topic ??= new PubSub().topic(TOPICS.classifyEmail));
}

export async function publishClassifyRequests(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await Promise.all(
    messageIds.map((messageId) => classifyTopic().publishMessage({ json: { messageId } })),
  );
}
