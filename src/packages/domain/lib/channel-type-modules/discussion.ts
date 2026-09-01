import * as z from 'zod/v4';

import { channelIdSchema, contract } from './contract';

export const discussionActions = [
  contract('discussion.message.post', z.object({
    channelId: channelIdSchema,
    recordReferences: z.array(z.string().min(1)).default([]),
    replyToMessageId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(20_000),
  })),
  contract('discussion.message.edit', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
    text: z.string().trim().min(1).max(20_000),
  })),
  contract('discussion.message.tombstone', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  })),
  contract('discussion.message.restore', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  })),
];

export const discussionActivityKinds = [
  'discussion.message-posted',
  'discussion.message-edited',
  'discussion.message-tombstoned',
  'discussion.message-restored',
] as const;

export const discussionQueries = [
  contract('discussion.messages.list', z.object({
    channelId: channelIdSchema,
    includeTombstoned: z.boolean().default(false),
  })),
  contract('discussion.message.revisions', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  })),
];

export const discussionView = {
  commands: discussionActions.map((candidate) => candidate.name),
  kind: 'discussion',
  query: 'discussion.messages.list',
};
