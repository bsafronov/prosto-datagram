import * as z from 'zod/v4';

import { channelIdSchema, contract, produceOwnedView } from './contract';
import type { DomainChange } from '../model';

export const discussionActivityFor = (changes: readonly DomainChange[]): string | undefined => {
  if (changes.some((change) => change.kind === 'discussion.message-posted')) {
    return 'discussion.message-posted';
  }
  if (changes.some((change) => change.kind === 'discussion.message-edited')) {
    return 'discussion.message-edited';
  }
  if (changes.some((change) => change.kind === 'discussion.message-tombstoned')) {
    return 'discussion.message-tombstoned';
  }
  if (changes.some((change) => change.kind === 'discussion.message-restored')) {
    return 'discussion.message-restored';
  }
  return undefined;
};

export const discussionActions = [
  contract('discussion.message.post', z.object({
    channelId: channelIdSchema,
    recordReferences: z.array(z.string().min(1)).default([]),
    replyToMessageId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(20_000),
  }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
  contract('discussion.message.edit', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
    text: z.string().trim().min(1).max(20_000),
  }), undefined, { kind: 'message-author-or-admin' }),
  contract('discussion.message.tombstone', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  }), undefined, { kind: 'message-author-or-admin' }),
  contract('discussion.message.restore', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  }), undefined, { kind: 'message-author-or-admin' }),
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
    includeTombstoned: z.boolean().default(true),
  })),
  contract('discussion.message.revisions', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  }), undefined, { kind: 'message-author-or-admin' }),
];

export const discussionView = {
  bindings: { messages: '$result' },
  commands: discussionActions.map((candidate) => candidate.name),
  kind: 'discussion',
  produce: produceOwnedView,
  query: 'discussion.messages.list',
  title: (input: { readonly channelTitle?: string }) =>
    `${input.channelTitle ?? 'Channel'} Discussion`,
};
