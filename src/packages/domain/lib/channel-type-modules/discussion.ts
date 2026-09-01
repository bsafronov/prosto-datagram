import * as z from 'zod/v4';

import { channelIdSchema, contract, produceOwnedView } from './contract';
import type { DomainChange } from '../model';
import { invariant } from '../errors';

const pendingView = () => ({ bindings: {}, commands: [], kind: 'pending', schemaVersion: 'datagram/view@1' as const, title: 'Channel Type View' });

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
  }), async (input, capabilities) => {
    if (!('changes' in capabilities)) throw new Error('Discussion posting needs Action capabilities');
    if (input.replyToMessageId) {
      const reply = await capabilities.state!.message(input.replyToMessageId);
      invariant(reply?.channelId === input.channelId, 'discussion.message-not-found', 'Reply Message not found', 404);
    }
    await capabilities.changes.postDiscussionMessage!({
      recordReferences: input.recordReferences,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
      text: input.text,
    });
    return capabilities.commit();
  }, { kind: 'channel-role', minimumRole: 'contributor' }, ['postDiscussionMessage']),
  contract('discussion.message.edit', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
    text: z.string().trim().min(1).max(20_000),
  }), async (input, capabilities) => {
    if (!('changes' in capabilities)) throw new Error('Discussion editing needs Action capabilities');
    const message = await capabilities.state!.message(input.messageId);
    invariant(message?.channelId === input.channelId, 'discussion.message-not-found', 'Message not found', 404);
    invariant(message.tombstonedAt === undefined, 'discussion.message-tombstoned', 'Tombstoned Message cannot be edited', 409);
    await capabilities.changes.editDiscussionMessage!(message.id, input.text);
    return capabilities.commit();
  }, { kind: 'message-author-or-admin' }, ['editDiscussionMessage']),
  contract('discussion.message.tombstone', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  }), async (input, capabilities) => {
    if (!('changes' in capabilities)) throw new Error('Discussion tombstone needs Action capabilities');
    const message = await capabilities.state!.message(input.messageId);
    invariant(message?.channelId === input.channelId, 'discussion.message-not-found', 'Message not found', 404);
    invariant(message.tombstonedAt === undefined, 'discussion.message-already-tombstoned', 'Message is already tombstoned', 409);
    await capabilities.changes.tombstoneDiscussionMessage!(message.id);
    return capabilities.commit();
  }, { kind: 'message-author-or-admin' }, ['tombstoneDiscussionMessage']),
  contract('discussion.message.restore', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  }), async (input, capabilities) => {
    if (!('changes' in capabilities)) throw new Error('Discussion restoration needs Action capabilities');
    const message = await capabilities.state!.message(input.messageId);
    invariant(message?.channelId === input.channelId, 'discussion.message-not-found', 'Message not found', 404);
    invariant(message.tombstonedAt !== undefined, 'discussion.message-not-tombstoned', 'Message is not tombstoned', 409);
    await capabilities.changes.restoreDiscussionMessage!(message.id);
    return capabilities.commit();
  }, { kind: 'message-author-or-admin' }, ['restoreDiscussionMessage']),
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
  }), async (input, capabilities) => {
    const messages = (await capabilities.state!.messages()).filter(
      (message) => input.includeTombstoned || message.tombstonedAt === undefined,
    );
    return {
      data: await Promise.all(messages.map(async (message) => ({
        authorId: message.authorId,
        createdAt: message.createdAt,
        id: message.id,
        recordReferences: message.tombstonedAt === undefined
          ? await Promise.all(message.recordReferences.map((recordId) => capabilities.state!.resolveRecordReference(recordId)))
          : [],
        ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
        text: message.tombstonedAt === undefined ? message.text : null,
        ...(message.tombstonedAt === undefined ? {} : { tombstonedAt: message.tombstonedAt }),
      }))),
      view: pendingView(),
    };
  }),
  contract('discussion.message.revisions', z.object({
    channelId: channelIdSchema,
    messageId: z.string().min(1),
  }), async (input, capabilities) => {
    const message = await capabilities.state!.message(input.messageId);
    invariant(message?.channelId === input.channelId, 'discussion.message-not-found', 'Message not found', 404);
    return {
      data: message.revisions.map((revision) => ({
        createdAt: revision.createdAt,
        editorId: revision.editorId,
        id: revision.id,
        text: revision.text,
      })),
      view: pendingView(),
    };
  }, { kind: 'message-author-or-admin' }),
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
