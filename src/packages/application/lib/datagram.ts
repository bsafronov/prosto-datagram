import * as z from 'zod/v4';

import { ChannelTypeRegistry } from '../../domain/channel-types';
import { DatagramError, invariant } from '../../domain/errors';
import {
  channelRoleSchema,
  jsonValueSchema,
  newId,
  nowIso,
  recordReferenceCardinalitySchema,
  tableFieldTypeSchema,
} from '../../domain/model';
import type {
  ActionReceipt,
  Channel,
  ChannelGroup,
  ChannelNavigation,
  ChannelInvitation,
  ChannelRole,
  DictionaryEntry,
  DomainChange,
  JsonValue,
  Message,
  Operation,
  OperationOrigin,
  PendingChannelActivity,
  Person,
  QueryResult,
  SubscriptionEvent,
  TableField,
  TableRecord,
  TableView,
} from '../../domain/model';
import type { DatagramStore } from './store';
import {
  ActionRegistry,
  QueryRegistry,
  defineAction,
  defineQuery,
} from './contracts';
import type { ExecutionContext } from './contracts';
import { ResultHandleBroker } from './result-handles';
import type { IssuedResultHandle } from './result-handles';

const roleRank: Readonly<Record<ChannelRole, number>> = {
  admin: 2,
  contributor: 1,
  owner: 3,
  viewer: 0,
};

const optionalJsonValueSchema = jsonValueSchema.optional();

const normalizeDictionaryLabel = (value: string): string => value.trim().normalize('NFC');

const dictionaryLabelSchema = z
  .string()
  .transform(normalizeDictionaryLabel)
  .pipe(z.string().min(1).max(160));

const dictionaryLabelKey = (value: string): string =>
  normalizeDictionaryLabel(value)
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');

const tableViewFilterSchema = z.object({
  fieldId: z.string().min(1),
  operator: z.enum(['contains', 'equals', 'greater-than', 'is-empty', 'less-than']),
  value: optionalJsonValueSchema,
});

const tableViewSortSchema = z.object({
  direction: z.enum(['ascending', 'descending']),
  fieldId: z.string().min(1),
});

const toJson = (value: unknown): JsonValue => jsonValueSchema.parse(value);

export class DatagramApplication {
  readonly actions: ActionRegistry;
  readonly queries: QueryRegistry;
  readonly handles: ResultHandleBroker;

  constructor(
    readonly store: DatagramStore,
    readonly channelTypes: ChannelTypeRegistry,
    handles = new ResultHandleBroker(),
  ) {
    this.handles = handles;
    this.actions = new ActionRegistry(this.#actionDefinitions());
    this.queries = new QueryRegistry(this.#queryDefinitions());
  }

  async executeAction(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<ActionReceipt> {
    await this.#requirePerson(actorId);
    return this.actions.execute(name, { actorId, origin }, input);
  }

  async executeQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<QueryResult> {
    await this.#requirePerson(actorId);
    return this.queries.execute(name, { actorId, origin }, input);
  }

  async prepareQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<IssuedResultHandle> {
    const result = await this.executeQuery(actorId, origin, name, input);
    return this.handles.issue(actorId, name, result);
  }

  async *subscribe(
    actorId: string,
    options: { readonly after?: number; readonly signal?: AbortSignal } = {},
  ): AsyncIterable<SubscriptionEvent> {
    await this.#requirePerson(actorId);
    invariant(
      options.after === undefined ||
        (Number.isSafeInteger(options.after) && options.after >= 0),
      'subscription.position-invalid',
      'Subscription position must be a non-negative integer',
    );
    let position = options.after ?? 0;

    while (!options.signal?.aborted) {
      await this.#requirePerson(actorId);
      const events = await this.store.listSubscriptionEvents(position, 100);
      if (events.length === 0) {
        await this.#waitForSubscriptionEvent(options.signal);
        continue;
      }
      for (const event of events) {
        position = event.position;
        if (await this.#canReceiveSubscriptionEvent(actorId, event)) yield event;
      }
    }
  }

  async #requirePerson(personId: string): Promise<Person> {
    const person = await this.store.getPerson(personId);
    invariant(person, 'person.not-found', 'Person does not exist', 404);
    invariant(
      person.deactivatedAt === undefined,
      'person.deactivated',
      'Person is deactivated',
      403,
    );
    return person;
  }

  async #canReceiveSubscriptionEvent(
    actorId: string,
    event: SubscriptionEvent,
  ): Promise<boolean> {
    const channelId = event.type === 'activity' ? event.activity.channelId : event.channelId;
    if (event.type === 'operation-result' && event.actorId !== actorId) return false;
    if (channelId === undefined) return true;
    return (await this.store.getMembership(channelId, actorId)) !== null;
  }

  async #waitForSubscriptionEvent(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 25);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async #requireChannel(channelId: string, typeId?: string): Promise<Channel> {
    const channel = await this.store.getChannel(channelId);
    invariant(channel, 'channel.not-found', 'Channel does not exist', 404);
    invariant(channel.purgedAt === undefined, 'channel.purged', 'Channel was purged', 410);
    invariant(channel.deletedAt === undefined, 'channel.deleted', 'Channel is deleted', 410);
    if (typeId) {
      invariant(
        channel.typeId === typeId,
        'channel.type-mismatch',
        `Channel must use type ${typeId}`,
      );
    }
    return channel;
  }

  async #requireStoredChannel(channelId: string): Promise<Channel> {
    const channel = await this.store.getChannel(channelId);
    invariant(channel, 'channel.not-found', 'Channel does not exist', 404);
    invariant(channel.purgedAt === undefined, 'channel.purged', 'Channel was purged', 410);
    return channel;
  }

  async #requireRole(
    actorId: string,
    channelId: string,
    minimum: ChannelRole,
  ): Promise<void> {
    const membership = await this.store.getMembership(channelId, actorId);
    invariant(membership, 'permission.denied', 'Channel membership is required', 403);
    invariant(
      roleRank[membership.role] >= roleRank[minimum],
      'permission.denied',
      `Channel Role ${minimum} is required`,
      403,
    );
  }

  async #requireGroup(actorId: string, groupId: string): Promise<ChannelGroup> {
    const group = await this.store.getChannelGroup(groupId);
    invariant(group, 'channel-group.not-found', 'Channel Group does not exist', 404);
    invariant(
      group.personId === actorId,
      'permission.denied',
      'Channel Group belongs to another person',
      403,
    );
    return group;
  }

  async #navigation(
    actorId: string,
    channelId: string,
    update: Partial<Omit<ChannelNavigation, 'channelId' | 'personId'>>,
  ): Promise<ChannelNavigation> {
    const current = await this.store.getChannelNavigation(channelId, actorId);
    return { ...current, ...update };
  }

  async #requireMessage(channelId: string, messageId: string): Promise<Message> {
    const message = await this.store.getMessage(messageId);
    invariant(message, 'discussion.message-not-found', 'Message does not exist', 404);
    invariant(
      message.channelId === channelId,
      'discussion.message-not-found',
      'Message does not exist',
      404,
    );
    return message;
  }

  async #requireMessageAuthorOrAdmin(actorId: string, message: Message): Promise<void> {
    await this.#requireRole(actorId, message.channelId, 'contributor');
    if (message.authorId !== actorId) {
      await this.#requireRole(actorId, message.channelId, 'admin');
    }
  }

  async #commit(
    context: ExecutionContext,
    action: string,
    channelId: string | undefined,
    build: (operationId: string, occurredAt: string) => readonly DomainChange[],
    subject?: ActionReceipt['subject'],
  ): Promise<ActionReceipt> {
    const operationId = newId('operation');
    const occurredAt = nowIso();
    const operation: Operation = {
      action,
      actorId: context.actorId,
      changes: build(operationId, occurredAt),
      ...(channelId === undefined ? {} : { channelId }),
      id: operationId,
      intent: action,
      occurredAt,
      origin: context.origin,
      result: {
        status: 'succeeded',
        ...(subject === undefined ? {} : { subject: { ...subject } }),
      },
      status: 'succeeded',
    };
    await this.store.commit(operation);
    return { action, operationId, ...(subject === undefined ? {} : { subject }) };
  }

  #activity(
    actorId: string,
    channelId: string,
    kind: string,
    operationId: string,
    occurredAt: string,
  ): PendingChannelActivity {
    return {
      actorId,
      channelId,
      id: newId('activity'),
      kind,
      occurredAt,
      operationId,
    };
  }

  #actionDefinitions() {
    return [
      defineAction({
        description: 'Create a Service-local person. Deployment Operator only.',
        inputSchema: z.object({ displayName: z.string().trim().min(1).max(120) }),
        name: 'service.person.create',
        run: async (context, input) => {
          const actor = await this.#requirePerson(context.actorId);
          invariant(actor.isOperator, 'permission.denied', 'Deployment Operator is required', 403);
          const person: Person = {
            createdAt: nowIso(),
            displayName: input.displayName,
            id: newId('person'),
            isOperator: false,
          };
          return this.#commit(
            context,
            'service.person.create',
            undefined,
            () => [{ kind: 'person.created', person }],
            { id: person.id, kind: 'person' },
          );
        },
      }),
      defineAction({
        description: 'Deactivate a Service-local person. Deployment Operator only.',
        inputSchema: z.object({ personId: z.string().min(1) }),
        name: 'service.person.deactivate',
        run: async (context, input) => {
          const actor = await this.#requirePerson(context.actorId);
          invariant(actor.isOperator, 'permission.denied', 'Deployment Operator is required', 403);
          await this.#requirePerson(input.personId);
          const ownedChannels = await this.store.listOwnedChannels(input.personId);
          invariant(
            ownedChannels.length === 0,
            'person.owns-channels',
            'Channel ownership must be transferred before deactivation',
            409,
          );
          const deactivatedAt = nowIso();
          return this.#commit(
            context,
            'service.person.deactivate',
            undefined,
            () => [{ deactivatedAt, kind: 'person.deactivated', personId: input.personId }],
            { id: input.personId, kind: 'person' },
          );
        },
      }),
      defineAction({
        description: 'Create a Channel from an approved bundled Channel Type.',
        inputSchema: z.object({
          title: z.string().trim().min(1).max(160),
          typeId: z.string().min(1),
        }),
        name: 'channel.create',
        run: async (context, input) => {
          await this.#requirePerson(context.actorId);
          const type = this.channelTypes.require(input.typeId);
          const channelId = newId('channel');
          const channel: Channel = {
            createdAt: nowIso(),
            id: channelId,
            ownerId: context.actorId,
            title: input.title,
            typeId: type.id,
            typeVersion: type.version,
            updatedAt: nowIso(),
          };
          return this.#commit(
            context,
            'channel.create',
            channelId,
            (operationId, occurredAt) => [
              { channel, kind: 'channel.created' },
              {
                kind: 'membership.granted',
                membership: { channelId, personId: context.actorId, role: 'owner' },
              },
              {
                activity: this.#activity(
                  context.actorId,
                  channelId,
                  'channel.created',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Grant an existing person a non-owner Channel Role.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          personId: z.string().min(1),
          role: channelRoleSchema.exclude(['owner']),
        }),
        name: 'channel.member.grant',
        run: async (context, input) => {
          const channel = await this.#requireChannel(input.channelId);
          await this.#requirePerson(input.personId);
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          invariant(
            channel.ownerId !== input.personId,
            'channel.owner-role-fixed',
            'Transfer ownership before changing the Owner role',
            409,
          );
          const previous = await this.store.getMembership(input.channelId, input.personId);
          return this.#commit(
            context,
            'channel.member.grant',
            input.channelId,
            (operationId, occurredAt) => [
              {
                kind: 'membership.granted',
                membership: {
                  channelId: input.channelId,
                  personId: input.personId,
                  role: input.role,
                },
                ...(previous ? { previousRole: previous.role } : {}),
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'channel.member-granted',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
          );
        },
      }),
      defineAction({
        description: 'Archive one Channel for the acting person only.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'channel.navigation.archive',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const navigation = await this.#navigation(context.actorId, input.channelId, {
            archivedAt: nowIso(),
          });
          return this.#commit(
            context,
            'channel.navigation.archive',
            input.channelId,
            () => [{ kind: 'channel-navigation.updated', navigation }],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Restore one personally Archived Channel.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'channel.navigation.restore',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const current = await this.store.getChannelNavigation(
            input.channelId,
            context.actorId,
          );
          const { archivedAt: _, ...navigation } = current;
          return this.#commit(
            context,
            'channel.navigation.restore',
            input.channelId,
            () => [{ kind: 'channel-navigation.updated', navigation }],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Mute or unmute Activity notifications without changing unread state.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          muted: z.boolean(),
        }),
        name: 'channel.navigation.mute',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const navigation = await this.#navigation(context.actorId, input.channelId, {
            muted: input.muted,
          });
          return this.#commit(
            context,
            'channel.navigation.mute',
            input.channelId,
            () => [{ kind: 'channel-navigation.updated', navigation }],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Pin and personally order one Channel in the Flat Channel List.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          pinned: z.boolean(),
          position: z.number().int().nonnegative().default(0),
        }),
        name: 'channel.navigation.pin',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const navigation = await this.#navigation(context.actorId, input.channelId, {
            pinned: input.pinned,
            position: input.position,
          });
          return this.#commit(
            context,
            'channel.navigation.pin',
            input.channelId,
            () => [{ kind: 'channel-navigation.updated', navigation }],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Mark Channel Activity through one visible Activity as read.',
        inputSchema: z.object({
          activityId: z.string().min(1).optional(),
          channelId: z.string().min(1),
        }),
        name: 'channel.activity.mark-read',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const activities = await this.store.listActivities(input.channelId);
          const activityId = input.activityId ?? activities.at(-1)?.id;
          if (activityId !== undefined) {
            const activity = await this.store.getActivity(activityId);
            invariant(
              activity?.channelId === input.channelId,
              'activity.not-found',
              'Activity does not exist in Channel',
              404,
            );
          }
          const current = await this.store.getChannelNavigation(
            input.channelId,
            context.actorId,
          );
          if (activityId !== undefined && current.lastReadActivityId !== undefined) {
            const currentIndex = activities.findIndex(
              (activity) => activity.id === current.lastReadActivityId,
            );
            const nextIndex = activities.findIndex((activity) => activity.id === activityId);
            invariant(
              nextIndex >= currentIndex,
              'activity.read-position-regression',
              'Read position cannot move backward',
              409,
            );
          }
          const navigation: ChannelNavigation =
            activityId === undefined
              ? current
              : { ...current, lastReadActivityId: activityId };
          return this.#commit(
            context,
            'channel.activity.mark-read',
            input.channelId,
            () => [{ kind: 'channel-navigation.updated', navigation }],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Create one personal Channel Group.',
        inputSchema: z.object({
          name: z.string().trim().min(1).max(120),
          position: z.number().int().nonnegative().default(0),
        }),
        name: 'channel.group.create',
        run: async (context, input) => {
          const group: ChannelGroup = {
            createdAt: nowIso(),
            id: newId('channel_group'),
            name: input.name,
            personId: context.actorId,
            position: input.position,
          };
          return this.#commit(
            context,
            'channel.group.create',
            undefined,
            () => [{ group, kind: 'channel-group.created' }],
            { id: group.id, kind: 'channel-group' },
          );
        },
      }),
      defineAction({
        description: 'Rename or reorder one personal Channel Group.',
        inputSchema: z.object({
          groupId: z.string().min(1),
          name: z.string().trim().min(1).max(120),
          position: z.number().int().nonnegative(),
        }),
        name: 'channel.group.update',
        run: async (context, input) => {
          const current = await this.#requireGroup(context.actorId, input.groupId);
          const group: ChannelGroup = {
            ...current,
            name: input.name,
            position: input.position,
          };
          return this.#commit(
            context,
            'channel.group.update',
            undefined,
            () => [{ group, kind: 'channel-group.updated' }],
          );
        },
      }),
      defineAction({
        description: 'Add or reorder one Channel in a personal overlapping Channel Group.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          groupId: z.string().min(1),
          pinned: z.boolean().default(false),
          position: z.number().int().nonnegative().default(0),
        }),
        name: 'channel.group.channel.add',
        run: async (context, input) => {
          await this.#requireGroup(context.actorId, input.groupId);
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          return this.#commit(
            context,
            'channel.group.channel.add',
            input.channelId,
            () => [
              {
                entry: {
                  channelId: input.channelId,
                  groupId: input.groupId,
                  pinned: input.pinned,
                  position: input.position,
                },
                kind: 'channel-group.entry-set',
              },
            ],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Remove one Channel from one personal Channel Group.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          groupId: z.string().min(1),
        }),
        name: 'channel.group.channel.remove',
        run: async (context, input) => {
          await this.#requireGroup(context.actorId, input.groupId);
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          return this.#commit(
            context,
            'channel.group.channel.remove',
            input.channelId,
            () => [
              {
                channelId: input.channelId,
                groupId: input.groupId,
                kind: 'channel-group.entry-removed',
              },
            ],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Transfer a Channel to a new single Owner. Owner only.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          personId: z.string().min(1),
        }),
        name: 'channel.owner.transfer',
        run: async (context, input) => {
          const channel = await this.#requireChannel(input.channelId);
          await this.#requirePerson(input.personId);
          invariant(
            channel.ownerId === context.actorId,
            'permission.denied',
            'Channel Owner is required',
            403,
          );
          invariant(
            input.personId !== context.actorId,
            'channel.owner-unchanged',
            'New Owner must be another person',
            409,
          );
          return this.#commit(
            context,
            'channel.owner.transfer',
            input.channelId,
            (operationId, occurredAt) => [
              {
                channelId: input.channelId,
                kind: 'channel.ownership-transferred',
                nextOwnerId: input.personId,
                previousOwnerId: context.actorId,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'channel.owner-transferred',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
          );
        },
      }),
      defineAction({
        description: 'Leave one Channel without changing its Owner.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'channel.member.leave',
        run: async (context, input) => {
          const channel = await this.#requireChannel(input.channelId);
          const membership = await this.store.getMembership(input.channelId, context.actorId);
          invariant(membership, 'permission.denied', 'Channel membership is required', 403);
          invariant(
            channel.ownerId !== context.actorId,
            'channel.owner-cannot-leave',
            'Transfer Channel ownership before leaving',
            409,
          );
          return this.#commit(
            context,
            'channel.member.leave',
            input.channelId,
            () => [
              { channelId: input.channelId, kind: 'membership.left', personId: context.actorId },
            ],
          );
        },
      }),
      defineAction({
        description: 'Shared recoverable Channel deletion. Owner only.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'channel.delete',
        run: async (context, input) => {
          const channel = await this.#requireChannel(input.channelId);
          invariant(
            channel.ownerId === context.actorId,
            'permission.denied',
            'Channel Owner is required',
            403,
          );
          const deletedAt = nowIso();
          return this.#commit(
            context,
            'channel.delete',
            input.channelId,
            (operationId) => [
              {
                actorId: context.actorId,
                channelId: input.channelId,
                deletedAt,
                kind: 'channel.deleted',
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'channel.deleted',
                  operationId,
                  deletedAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Restore one recoverably deleted Channel. Owner only.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'channel.restore',
        run: async (context, input) => {
          const channel = await this.#requireStoredChannel(input.channelId);
          invariant(channel.deletedAt, 'channel.not-deleted', 'Channel is not deleted', 409);
          invariant(
            channel.ownerId === context.actorId,
            'permission.denied',
            'Channel Owner is required',
            403,
          );
          const restoredAt = nowIso();
          return this.#commit(
            context,
            'channel.restore',
            input.channelId,
            (operationId) => [
              {
                actorId: context.actorId,
                channelId: input.channelId,
                kind: 'channel.restored',
                restoredAt,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'channel.restored',
                  operationId,
                  restoredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Permanently purge one deleted Channel. Owner explicit approval required.',
        inputSchema: z.object({
          approved: z.literal(true),
          channelId: z.string().min(1),
        }),
        name: 'channel.purge',
        run: async (context, input) => {
          const channel = await this.#requireStoredChannel(input.channelId);
          invariant(channel.deletedAt, 'channel.not-deleted', 'Delete Channel before purge', 409);
          invariant(
            channel.ownerId === context.actorId,
            'permission.denied',
            'Channel Owner is required',
            403,
          );
          const purgedAt = nowIso();
          return this.#commit(
            context,
            'channel.purge',
            input.channelId,
            () => [
              {
                actorId: context.actorId,
                channelId: input.channelId,
                kind: 'channel.purged',
                purgedAt,
              },
            ],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Create an expiring invitation for one Channel and non-owner role.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          expiresAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
            message: 'Expected ISO date-time',
          }),
          role: channelRoleSchema.exclude(['owner']),
        }),
        name: 'channel.invitation.create',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          invariant(
            Date.parse(input.expiresAt) > Date.now(),
            'invitation.expiry-invalid',
            'Invitation expiry must be in the future',
          );
          const invitation: ChannelInvitation = {
            channelId: input.channelId,
            createdAt: nowIso(),
            createdBy: context.actorId,
            expiresAt: new Date(input.expiresAt).toISOString(),
            id: newId('invitation'),
            proposedRole: input.role,
          };
          return this.#commit(
            context,
            'channel.invitation.create',
            input.channelId,
            (operationId, occurredAt) => [
              { invitation, kind: 'invitation.created' },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'channel.invitation-created',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: invitation.id, kind: 'invitation' },
          );
        },
      }),
      defineAction({
        description: 'Accept a Channel invitation for an existing or new Service-local person.',
        inputSchema: z
          .object({
            displayName: z.string().trim().min(1).max(120).optional(),
            invitationId: z.string().min(1),
            personId: z.string().min(1).optional(),
          })
          .refine((input) => !(input.displayName && input.personId), {
            message: 'Choose an existing person or a new display name',
          }),
        name: 'channel.invitation.accept',
        run: async (context, input) => {
          const invitation = await this.store.getInvitation(input.invitationId);
          invariant(invitation, 'invitation.not-found', 'Invitation does not exist', 404);
          invariant(
            invitation.acceptedAt === undefined,
            'invitation.already-accepted',
            'Invitation was already accepted',
            409,
          );
          invariant(
            Date.parse(invitation.expiresAt) > Date.now(),
            'invitation.expired',
            'Invitation has expired',
            410,
          );
          const channel = await this.#requireChannel(invitation.channelId);
          if (input.displayName !== undefined || input.personId !== undefined) {
            await this.#requireRole(context.actorId, invitation.channelId, 'admin');
          }

          const newPerson: Person | undefined =
            input.displayName === undefined
              ? undefined
              : {
                  createdAt: nowIso(),
                  displayName: input.displayName,
                  id: newId('person'),
                  isOperator: false,
                };
          const personId = newPerson?.id ?? input.personId ?? context.actorId;
          if (!newPerson) await this.#requirePerson(personId);
          invariant(
            personId !== channel.ownerId,
            'channel.owner-role-fixed',
            'Channel Owner cannot accept a non-owner role',
            409,
          );
          const previous = await this.store.getMembership(invitation.channelId, personId);
          const acceptedAt = nowIso();
          return this.#commit(
            context,
            'channel.invitation.accept',
            invitation.channelId,
            (operationId, occurredAt) => [
              ...(newPerson
                ? ([{ kind: 'person.created', person: newPerson }] as const)
                : []),
              {
                kind: 'membership.granted' as const,
                membership: {
                  channelId: invitation.channelId,
                  personId,
                  role: invitation.proposedRole,
                },
                ...(previous ? { previousRole: previous.role } : {}),
              },
              {
                acceptedAt,
                acceptedBy: personId,
                invitationId: invitation.id,
                kind: 'invitation.accepted' as const,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  invitation.channelId,
                  'channel.invitation-accepted',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended' as const,
              },
            ],
            { id: personId, kind: 'person' },
          );
        },
      }),
      defineAction({
        description: 'Undo a reversible membership grant when its effect is still current.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          operationId: z.string().min(1),
        }),
        name: 'operation.undo',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const operations = await this.store.listOperations(input.channelId);
          const original = operations.find((operation) => operation.id === input.operationId);
          invariant(original, 'operation.not-found', 'Operation does not exist', 404);
          invariant(
            original.action === 'channel.member.grant',
            'operation.not-reversible',
            'Operation is not reversible',
            409,
          );
          const granted = original.changes.find(
            (change) => change.kind === 'membership.granted',
          );
          invariant(
            granted?.kind === 'membership.granted',
            'operation.not-reversible',
            'Operation has no reversible membership change',
            409,
          );
          invariant(
            !operations.some(
              (operation) =>
                operation.action === 'operation.undo' &&
                operation.changes.some(
                  (change) =>
                    change.kind === 'membership.reverted' &&
                    change.revertedOperationId === original.id,
                ),
            ),
            'operation.already-undone',
            'Operation was already undone',
            409,
          );
          return this.#commit(
            context,
            'operation.undo',
            input.channelId,
            (operationId, occurredAt) => [
              {
                channelId: granted.membership.channelId,
                expectedRole: granted.membership.role,
                kind: 'membership.reverted',
                personId: granted.membership.personId,
                revertedOperationId: original.id,
                ...(granted.previousRole ? { restoredRole: granted.previousRole } : {}),
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'operation.undone',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
          );
        },
      }),
      defineAction({
        description: 'Create a stable Entry in a Dictionary Channel. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          label: dictionaryLabelSchema,
        }),
        name: 'dictionary.entry.create',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'dictionary');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const normalizedLabel = dictionaryLabelKey(input.label);
          const entries = await this.store.listDictionaryEntries(input.channelId);
          invariant(
            !entries.some((entry) => entry.normalizedLabel === normalizedLabel),
            'dictionary.entry-label-conflict',
            'Dictionary Entry label already exists',
            409,
          );
          const entry: DictionaryEntry = {
            channelId: input.channelId,
            createdAt: nowIso(),
            createdBy: context.actorId,
            id: newId('dictionary_entry'),
            label: input.label,
            normalizedLabel,
          };
          return this.#commit(
            context,
            'dictionary.entry.create',
            input.channelId,
            (operationId, occurredAt) => [
              { entry, kind: 'dictionary.entry-created' },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'dictionary.entry-created',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: entry.id, kind: 'dictionary-entry' },
          );
        },
      }),
      defineAction({
        description: 'Rename a Dictionary Entry without changing identity. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          entryId: z.string().min(1),
          label: dictionaryLabelSchema,
        }),
        name: 'dictionary.entry.rename',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'dictionary');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const entry = await this.#requireDictionaryEntry(input.channelId, input.entryId);
          const normalizedLabel = dictionaryLabelKey(input.label);
          const entries = await this.store.listDictionaryEntries(input.channelId);
          invariant(
            !entries.some(
              (candidate) =>
                candidate.id !== entry.id && candidate.normalizedLabel === normalizedLabel,
            ),
            'dictionary.entry-label-conflict',
            'Dictionary Entry label already exists',
            409,
          );
          return this.#commit(
            context,
            'dictionary.entry.rename',
            input.channelId,
            (operationId, occurredAt) => [
              {
                entryId: entry.id,
                kind: 'dictionary.entry-renamed',
                label: input.label,
                normalizedLabel,
                updatedAt: occurredAt,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'dictionary.entry-renamed',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: entry.id, kind: 'dictionary-entry' },
          );
        },
      }),
      defineAction({
        description: 'Retire a Dictionary Entry from new selection. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          entryId: z.string().min(1),
        }),
        name: 'dictionary.entry.retire',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'dictionary');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const entry = await this.#requireDictionaryEntry(input.channelId, input.entryId);
          invariant(
            entry.retiredAt === undefined,
            'dictionary.entry-retired',
            'Dictionary Entry is already retired',
            409,
          );
          return this.#commit(
            context,
            'dictionary.entry.retire',
            input.channelId,
            (operationId, occurredAt) => [
              {
                actorId: context.actorId,
                entryId: entry.id,
                kind: 'dictionary.entry-retired',
                retiredAt: occurredAt,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'dictionary.entry-retired',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: entry.id, kind: 'dictionary-entry' },
          );
        },
      }),
      defineAction({
        description: 'Restore a retired Dictionary Entry. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          entryId: z.string().min(1),
        }),
        name: 'dictionary.entry.restore',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'dictionary');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const entry = await this.#requireDictionaryEntry(input.channelId, input.entryId);
          invariant(
            entry.retiredAt !== undefined,
            'dictionary.entry-active',
            'Dictionary Entry is not retired',
            409,
          );
          return this.#commit(
            context,
            'dictionary.entry.restore',
            input.channelId,
            (operationId, occurredAt) => [
              {
                entryId: entry.id,
                kind: 'dictionary.entry-restored',
                restoredAt: occurredAt,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'dictionary.entry-restored',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: entry.id, kind: 'dictionary-entry' },
          );
        },
      }),
      defineAction({
        description: 'Add a typed Field to a Table Channel. Admin role required.',
        inputSchema: z.object({
          cardinality: recordReferenceCardinalitySchema.optional(),
          channelId: z.string().min(1),
          defaultValue: optionalJsonValueSchema,
          key: z.string().regex(/^[a-z][a-z0-9_]*$/),
          label: z.string().trim().min(1).max(120),
          required: z.boolean().default(false),
          targetChannelId: z.string().min(1).optional(),
          type: tableFieldTypeSchema,
          unique: z.boolean().default(false),
        }),
        name: 'table.field.add',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const fields = await this.store.listTableFields(input.channelId);
          invariant(
            !fields.some((field) => field.key === input.key),
            'table.field-key-conflict',
            `Field key already exists: ${input.key}`,
            409,
          );
          const allRecords = await this.store.listTableRecords(input.channelId);
          const records = allRecords.filter(
            (record) => record.tombstonedAt === undefined,
          );
          const isRecordReference = input.type === 'record-reference';
          invariant(
            isRecordReference
              ? input.targetChannelId !== undefined && input.cardinality !== undefined
              : input.targetChannelId === undefined && input.cardinality === undefined,
            'table.field-reference-configuration',
            'Record Reference Field requires one target Channel and cardinality',
          );
          if (isRecordReference) {
            await this.#requireChannel(input.targetChannelId!, 'table');
            await this.#requireRole(context.actorId, input.targetChannelId!, 'viewer');
          }
          if (input.defaultValue !== undefined) {
            invariant(
              !(input.required && input.defaultValue === null),
              'table.record-required-field',
              `Required Field cannot default to null: ${input.key}`,
            );
            if (input.defaultValue !== null) {
              const candidateField: TableField = {
                ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
                channelId: input.channelId,
                id: 'candidate',
                key: input.key,
                label: input.label,
                required: input.required,
                ...(input.targetChannelId === undefined
                  ? {}
                  : { targetChannelId: input.targetChannelId }),
                type: input.type,
                unique: input.unique,
              };
              this.#validateFieldValue(candidateField, input.defaultValue);
              await this.#validateRecordReferenceTargets(
                context.actorId,
                candidateField,
                input.defaultValue,
              );
            }
          }
          invariant(
            !(input.required && input.defaultValue === undefined && records.length > 0),
            'table.field-required-existing-records',
            'Required Field needs a default while Records exist',
            409,
          );
          invariant(
            !(input.unique && input.defaultValue != null && records.length > 1),
            'table.field-unique-default-conflict',
            'Unique Field default cannot be applied to multiple Records',
            409,
          );
          const field: TableField = {
            ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
            channelId: input.channelId,
            ...(input.defaultValue === undefined
              ? {}
              : { defaultValue: input.defaultValue }),
            id: newId('field'),
            key: input.key,
            label: input.label,
            required: input.required,
            ...(input.targetChannelId === undefined
              ? {}
              : { targetChannelId: input.targetChannelId }),
            type: input.type,
            unique: input.unique,
          };
          return this.#commit(
            context,
            'table.field.add',
            input.channelId,
            (operationId, occurredAt) => [
              { field, kind: 'table.field-added' },
              ...(input.defaultValue === undefined
                ? []
                : allRecords.map((record) => ({
                    kind: 'table.record-updated' as const,
                    recordId: record.id,
                    updatedAt: occurredAt,
                    values: { ...record.values, [input.key]: input.defaultValue! },
                  }))),
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'table.schema-changed',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: field.id, kind: 'field' },
          );
        },
      }),
      defineAction({
        description: 'Create a validated Record in a Table Channel. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          values: z.record(z.string(), jsonValueSchema),
        }),
        name: 'table.record.create',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const fields = await this.store.listTableFields(input.channelId);
          const records = await this.store.listTableRecords(input.channelId);
          const values = await this.#validatedRecordValues(
            context.actorId,
            fields,
            records,
            input.values,
          );
          const occurredAt = nowIso();
          const recordId = newId('record');
          return this.#commit(
            context,
            'table.record.create',
            input.channelId,
            (operationId) => [
              {
                kind: 'table.record-created',
                record: {
                  channelId: input.channelId,
                  createdAt: occurredAt,
                  createdBy: context.actorId,
                  id: recordId,
                  values,
                },
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'table.record-created',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: recordId, kind: 'record' },
          );
        },
      }),
      defineAction({
        description: 'Select a Text Field as the Table Display Field. Admin role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          fieldId: z.string().min(1).nullable(),
        }),
        name: 'table.display-field.set',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          if (input.fieldId !== null) {
            const fields = await this.store.listTableFields(input.channelId);
            const field = fields.find((candidate) => candidate.id === input.fieldId);
            invariant(field, 'table.field-not-found', 'Display Field does not exist', 404);
            invariant(
              field.type === 'text',
              'table.display-field-type',
              'Display Field must be Text',
            );
          }
          return this.#commit(
            context,
            'table.display-field.set',
            input.channelId,
            (operationId, occurredAt) => [
              {
                channelId: input.channelId,
                ...(input.fieldId === null ? {} : { displayFieldId: input.fieldId }),
                kind: 'table.display-field-set',
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'table.display-field-changed',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
          );
        },
      }),
      defineAction({
        description: 'Edit any active Table Record. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          recordId: z.string().min(1),
          values: z.record(z.string(), jsonValueSchema),
        }),
        name: 'table.record.edit',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const record = await this.#requireTableRecord(input.channelId, input.recordId);
          invariant(
            record.tombstonedAt === undefined,
            'table.record-tombstoned',
            'Table Record is tombstoned',
            409,
          );
          const fields = await this.store.listTableFields(input.channelId);
          const records = await this.store.listTableRecords(input.channelId);
          const values = await this.#validatedRecordValues(
            context.actorId,
            fields,
            records,
            { ...record.values, ...input.values },
            record.id,
          );
          const updatedAt = nowIso();
          return this.#commit(
            context,
            'table.record.edit',
            input.channelId,
            (operationId) => [
              { kind: 'table.record-updated', recordId: record.id, updatedAt, values },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'table.record-edited',
                  operationId,
                  updatedAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: record.id, kind: 'record' },
          );
        },
      }),
      defineAction({
        description: 'Tombstone any active Table Record. Contributor role required.',
        inputSchema: z.object({ channelId: z.string().min(1), recordId: z.string().min(1) }),
        name: 'table.record.tombstone',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const record = await this.#requireTableRecord(input.channelId, input.recordId);
          invariant(
            record.tombstonedAt === undefined,
            'table.record-already-tombstoned',
            'Table Record is already tombstoned',
            409,
          );
          const tombstonedAt = nowIso();
          return this.#commit(
            context,
            'table.record.tombstone',
            input.channelId,
            (operationId) => [
              {
                actorId: context.actorId,
                kind: 'table.record-tombstoned',
                recordId: record.id,
                tombstonedAt,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'table.record-tombstoned',
                  operationId,
                  tombstonedAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: record.id, kind: 'record' },
          );
        },
      }),
      defineAction({
        description: 'Restore a tombstoned Table Record. Contributor role required.',
        inputSchema: z.object({ channelId: z.string().min(1), recordId: z.string().min(1) }),
        name: 'table.record.restore',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const record = await this.#requireTableRecord(input.channelId, input.recordId);
          invariant(
            record.tombstonedAt !== undefined,
            'table.record-not-tombstoned',
            'Table Record is not tombstoned',
            409,
          );
          const fields = await this.store.listTableFields(input.channelId);
          const records = await this.store.listTableRecords(input.channelId);
          const values = await this.#validatedRecordValues(
            context.actorId,
            fields,
            records,
            record.values,
            record.id,
            false,
          );
          const restoredAt = nowIso();
          return this.#commit(
            context,
            'table.record.restore',
            input.channelId,
            (operationId) => [
              {
                kind: 'table.record-updated',
                recordId: record.id,
                updatedAt: restoredAt,
                values,
              },
              { kind: 'table.record-restored', recordId: record.id, restoredAt },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'table.record-restored',
                  operationId,
                  restoredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: record.id, kind: 'record' },
          );
        },
      }),
      defineAction({
        description: 'Create a personal or shared semantic Table View.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          filters: z.array(tableViewFilterSchema).default([]),
          grouping: z.array(z.string().min(1)).default([]),
          name: z.string().trim().min(1).max(120),
          sorting: z.array(tableViewSortSchema).default([]),
          visibility: z.enum(['personal', 'shared']),
          visibleFieldIds: z.array(z.string().min(1)),
        }),
        name: 'table.view.create',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(
            context.actorId,
            input.channelId,
            input.visibility === 'shared' ? 'admin' : 'viewer',
          );
          const fields = await this.store.listTableFields(input.channelId);
          const knownIds = new Set(fields.map((field) => field.id));
          const referencedIds = [
            ...input.visibleFieldIds,
            ...input.filters.map((filter) => filter.fieldId),
            ...input.sorting.map((sort) => sort.fieldId),
            ...input.grouping,
          ];
          invariant(
            referencedIds.every((fieldId) => knownIds.has(fieldId)),
            'table.view-unknown-field',
            'Table View references an unknown Field',
          );
          invariant(
            new Set(input.visibleFieldIds).size === input.visibleFieldIds.length,
            'table.view-duplicate-field',
            'Visible Fields must be unique',
          );
          const view: TableView = {
            channelId: input.channelId,
            createdAt: nowIso(),
            filters: input.filters.map((filter) => ({
              fieldId: filter.fieldId,
              operator: filter.operator,
              ...(filter.value === undefined ? {} : { value: filter.value }),
            })),
            grouping: input.grouping,
            id: newId('view'),
            name: input.name,
            ownerId: context.actorId,
            sorting: input.sorting,
            visibility: input.visibility,
            visibleFieldIds: input.visibleFieldIds,
          };
          return this.#commit(
            context,
            'table.view.create',
            input.channelId,
            (operationId, occurredAt) => [
              { kind: 'table.view-saved', view },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  input.visibility === 'shared'
                    ? 'table.shared-view-created'
                    : 'table.personal-view-created',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
          );
        },
      }),
      defineAction({
        description: 'Post a Message in any Channel Discussion. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          recordReferences: z.array(z.string().min(1)).default([]),
          replyToMessageId: z.string().min(1).optional(),
          text: z.string().trim().min(1).max(20_000),
        }),
        name: 'discussion.message.post',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          if (input.replyToMessageId !== undefined) {
            await this.#requireMessage(input.channelId, input.replyToMessageId);
          }
          const messageId = newId('message');
          const revisionId = newId('revision');
          const occurredAt = nowIso();
          return this.#commit(
            context,
            'discussion.message.post',
            input.channelId,
            (operationId) => [
              {
                kind: 'discussion.message-posted',
                message: {
                  authorId: context.actorId,
                  channelId: input.channelId,
                  createdAt: occurredAt,
                  id: messageId,
                  recordReferences: input.recordReferences,
                  ...(input.replyToMessageId === undefined
                    ? {}
                    : { replyToMessageId: input.replyToMessageId }),
                  revisions: [
                    {
                      createdAt: occurredAt,
                      editorId: context.actorId,
                      id: revisionId,
                      text: input.text,
                    },
                  ],
                  text: input.text,
                },
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'discussion.message-posted',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: messageId, kind: 'message' },
          );
        },
      }),
      defineAction({
        description: 'Edit an active Message while preserving its revision history. Author only.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          messageId: z.string().min(1),
          text: z.string().trim().min(1).max(20_000),
        }),
        name: 'discussion.message.edit',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          const message = await this.#requireMessage(input.channelId, input.messageId);
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          invariant(
            message.authorId === context.actorId,
            'permission.denied',
            'Only the Message author can edit it',
            403,
          );
          invariant(
            message.tombstonedAt === undefined,
            'discussion.message-tombstoned',
            'Tombstoned Message cannot be edited',
            409,
          );
          const occurredAt = nowIso();
          return this.#commit(
            context,
            'discussion.message.edit',
            input.channelId,
            (operationId) => [
              {
                kind: 'discussion.message-edited',
                messageId: input.messageId,
                revision: {
                  createdAt: occurredAt,
                  editorId: context.actorId,
                  id: newId('revision'),
                  text: input.text,
                },
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'discussion.message-edited',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.messageId, kind: 'message' },
          );
        },
      }),
      defineAction({
        description: 'Tombstone a Message. Authors may act on their own; Admins may moderate any.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          messageId: z.string().min(1),
        }),
        name: 'discussion.message.tombstone',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          const message = await this.#requireMessage(input.channelId, input.messageId);
          await this.#requireMessageAuthorOrAdmin(context.actorId, message);
          invariant(
            message.tombstonedAt === undefined,
            'discussion.message-already-tombstoned',
            'Message is already tombstoned',
            409,
          );
          const occurredAt = nowIso();
          return this.#commit(
            context,
            'discussion.message.tombstone',
            input.channelId,
            (operationId) => [
              {
                actorId: context.actorId,
                kind: 'discussion.message-tombstoned',
                messageId: input.messageId,
                tombstonedAt: occurredAt,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'discussion.message-tombstoned',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.messageId, kind: 'message' },
          );
        },
      }),
      defineAction({
        description: 'Restore a Message. Authors may act on their own; Admins may moderate any.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          messageId: z.string().min(1),
        }),
        name: 'discussion.message.restore',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          const message = await this.#requireMessage(input.channelId, input.messageId);
          await this.#requireMessageAuthorOrAdmin(context.actorId, message);
          invariant(
            message.tombstonedAt !== undefined,
            'discussion.message-not-tombstoned',
            'Message is not tombstoned',
            409,
          );
          const occurredAt = nowIso();
          return this.#commit(
            context,
            'discussion.message.restore',
            input.channelId,
            (operationId) => [
              {
                kind: 'discussion.message-restored',
                messageId: input.messageId,
                restoredBy: context.actorId,
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'discussion.message-restored',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.messageId, kind: 'message' },
          );
        },
      }),
    ];
  }

  #queryDefinitions() {
    return [
      defineQuery({
        description: 'List ordered meaningful Activity for one authorized Channel.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'channel.activity.list',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const activities = await this.store.listActivities(input.channelId);
          return {
            data: activities.map((activity) => ({
              actorId: activity.actorId,
              id: activity.id,
              kind: activity.kind,
              occurredAt: activity.occurredAt,
              operationId: activity.operationId,
              position: activity.position,
            })),
            view: {
              bindings: { activities: '$result' },
              commands: ['channel.activity.mark-read'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Channel Activity',
            },
          };
        },
      }),
      defineQuery({
        description: 'Inspect permitted Operation History for one Channel.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'operation.history',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId);
          const membership = await this.store.getMembership(input.channelId, context.actorId);
          invariant(membership, 'permission.denied', 'Channel membership is required', 403);
          invariant(
            membership.role !== 'viewer',
            'permission.denied',
            'Operation History is not available to Viewers',
            403,
          );
          const operations = await this.store.listOperations(input.channelId);
          const visible =
            membership.role === 'contributor'
              ? operations.filter((operation) => operation.actorId === context.actorId)
              : operations;
          return {
            data: visible.map((operation) => ({
              actorId: operation.actorId,
              changes: toJson(operation.changes),
              id: operation.id,
              intent: operation.intent,
              occurredAt: operation.occurredAt,
              origin: operation.origin,
              result: operation.result,
            })),
            view: {
              bindings: { operations: '$result' },
              commands: ['operation.undo'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Operation History',
            },
          };
        },
      }),
      defineQuery({
        description: 'Resolve a stable Channel or Table Record reference when permitted.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          recordId: z.string().min(1).optional(),
        }),
        name: 'channel.reference.resolve',
        run: async (context, input): Promise<QueryResult> => {
          const resolution = await this.#resolveReference(
            context.actorId,
            input.channelId,
            input.recordId,
          );
          return {
            data: resolution,
            view: {
              bindings: { reference: '$result' },
              commands: [],
              kind: 'value',
              schemaVersion: 'datagram/view@1',
              title: 'Reference Resolution',
            },
          };
        },
      }),
      defineQuery({
        description: 'List Channels accessible to the requesting person.',
        inputSchema: z.object({ archived: z.boolean().default(false) }),
        name: 'channel.list',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requirePerson(context.actorId);
          const items = await this.store.listChannelNavigation(context.actorId);
          const groups = await this.store.listChannelGroups(context.actorId);
          const entries = (
            await Promise.all(groups.map((group) => this.store.listChannelGroupEntries(group.id)))
          ).flat();
          return {
            data: items
              .filter((item) => (item.navigation.archivedAt !== undefined) === input.archived)
              .map((item) => ({
                archivedAt: item.navigation.archivedAt ?? null,
                groups: entries
                  .filter((entry) => entry.channelId === item.channel.id)
                  .map((entry) => ({
                    groupId: entry.groupId,
                    pinned: entry.pinned,
                    position: entry.position,
                  })),
                id: item.channel.id,
                lastReadActivityId: item.navigation.lastReadActivityId ?? null,
                muted: item.navigation.muted,
                pinned: item.navigation.pinned,
                position: item.navigation.position,
                title: item.channel.title,
                typeId: item.channel.typeId,
                typeVersion: item.channel.typeVersion,
                unreadCount: item.unreadCount,
                updatedAt: item.channel.updatedAt,
              })),
            view: {
              bindings: { items: '$result' },
              commands: [
                'channel.create',
                'channel.navigation.archive',
                'channel.navigation.restore',
                'channel.navigation.mute',
                'channel.navigation.pin',
                'channel.activity.mark-read',
                'channel.group.channel.add',
              ],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: input.archived ? 'Archived Channels' : 'Channels',
            },
          };
        },
      }),
      defineQuery({
        description: 'List personal Channel Groups and their ordered overlapping entries.',
        inputSchema: z.object({}),
        name: 'channel.groups.list',
        run: async (context): Promise<QueryResult> => {
          const groups = await this.store.listChannelGroups(context.actorId);
          const data = await Promise.all(
            groups.map(async (group) => ({
              entries: (await this.store.listChannelGroupEntries(group.id)).map((entry) => ({
                channelId: entry.channelId,
                pinned: entry.pinned,
                position: entry.position,
              })),
              id: group.id,
              name: group.name,
              position: group.position,
            })),
          );
          return {
            data,
            view: {
              bindings: { groups: '$result' },
              commands: [
                'channel.group.create',
                'channel.group.update',
                'channel.group.channel.add',
                'channel.group.channel.remove',
              ],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Channel Groups',
            },
          };
        },
      }),
      defineQuery({
        description: 'List selectable or all Entries in a Dictionary Channel.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          includeRetired: z.boolean().default(false),
        }),
        name: 'dictionary.entries.list',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId, 'dictionary');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const entries = (await this.store.listDictionaryEntries(input.channelId)).filter(
            (entry) => input.includeRetired || entry.retiredAt === undefined,
          );
          return {
            data: entries.map((entry) => ({
              id: entry.id,
              label: entry.label,
              ...(entry.retiredAt === undefined ? {} : { retiredAt: entry.retiredAt }),
            })),
            view: {
              bindings: { entries: '$result' },
              commands: [
                'dictionary.entry.create',
                'dictionary.entry.rename',
                'dictionary.entry.retire',
                'dictionary.entry.restore',
              ],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Dictionary Entries',
            },
          };
        },
      }),
      defineQuery({
        description: 'Describe the active Fields in a Table Channel.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.describe',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const fields = await this.store.listTableFields(input.channelId);
          return {
            data: fields.map((field) => ({
              ...(field.cardinality === undefined ? {} : { cardinality: field.cardinality }),
              id: field.id,
              key: field.key,
              label: field.label,
              required: field.required,
              ...(field.targetChannelId === undefined
                ? {}
                : { targetChannelId: field.targetChannelId }),
              type: field.type,
              unique: field.unique,
            })),
            view: {
              bindings: { fields: '$result' },
              commands: ['table.field.add', 'table.record.create'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: `${channel.title} Fields`,
            },
          };
        },
      }),
      defineQuery({
        description: 'Describe Table display configuration without Record values.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.configuration',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          return {
            data: { displayFieldId: await this.store.getTableDisplayFieldId(input.channelId) },
            view: {
              bindings: { configuration: '$result' },
              commands: ['table.display-field.set'],
              kind: 'value',
              schemaVersion: 'datagram/view@1',
              title: 'Table Configuration',
            },
          };
        },
      }),
      defineQuery({
        description: 'List current Records in a Table Channel.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          includeTombstoned: z.boolean().default(false),
        }),
        name: 'table.records.list',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const records = (await this.store.listTableRecords(input.channelId)).filter(
            (record) => input.includeTombstoned || record.tombstonedAt === undefined,
          );
          const fields = await this.store.listTableFields(input.channelId);
          return {
            data: await Promise.all(records.map(async (record) => ({
              id: record.id,
              ...(record.tombstonedAt === undefined
                ? {}
                : { tombstonedAt: record.tombstonedAt }),
              values: await this.#resolveRecordReferenceValues(
                context.actorId,
                fields,
                record.values,
              ),
            }))),
            view: {
              bindings: { rows: '$result' },
              commands: ['table.record.create'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: channel.title,
            },
          };
        },
      }),
      defineQuery({
        description: 'List shared Table Views and the actor personal Views.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.views.list',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const views = await this.store.listTableViews(input.channelId, context.actorId);
          return {
            data: toJson(views.map((view) => ({
              filters: [...view.filters],
              grouping: [...view.grouping],
              id: view.id,
              name: view.name,
              ownerId: view.ownerId,
              sorting: [...view.sorting],
              visibility: view.visibility,
              visibleFieldIds: [...view.visibleFieldIds],
            }))),
            view: {
              bindings: { views: '$result' },
              commands: ['table.view.create'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Table Views',
            },
          };
        },
      }),
      defineQuery({
        description: 'List Messages in one Channel Discussion.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'discussion.messages.list',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId);
          const membership = await this.store.getMembership(input.channelId, context.actorId);
          invariant(membership, 'permission.denied', 'Channel membership is required', 403);
          const messages = await this.store.listMessages(input.channelId);
          return {
            data: await Promise.all(
              messages.map(async (message) => ({
                authorId: message.authorId,
                createdAt: message.createdAt,
                id: message.id,
                recordReferences:
                  message.tombstonedAt === undefined
                    ? await Promise.all(
                        message.recordReferences.map(async (recordId) => {
                          const record = await this.store.getTableRecord(recordId);
                          return record
                            ? this.#resolveReference(context.actorId, record.channelId, recordId)
                            : { recordId, status: 'unresolved' as const };
                        }),
                      )
                    : [],
                ...(message.replyToMessageId === undefined
                  ? {}
                  : { replyToMessageId: message.replyToMessageId }),
                text: message.tombstonedAt === undefined ? message.text : null,
                ...(message.tombstonedAt === undefined
                  ? {}
                  : { tombstonedAt: message.tombstonedAt }),
              })),
            ),
            view: {
              bindings: { messages: '$result' },
              commands:
                membership.role === 'viewer'
                  ? []
                  : [
                      'discussion.message.post',
                      'discussion.message.edit',
                      'discussion.message.tombstone',
                      'discussion.message.restore',
                    ],
              kind: 'discussion',
              schemaVersion: 'datagram/view@1',
              title: `${channel.title} Discussion`,
            },
          };
        },
      }),
      defineQuery({
        description: 'Inspect one Message revision history under Operation History policy.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          messageId: z.string().min(1),
        }),
        name: 'discussion.message.revisions',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId);
          const message = await this.#requireMessage(input.channelId, input.messageId);
          const membership = await this.store.getMembership(input.channelId, context.actorId);
          invariant(membership, 'permission.denied', 'Channel membership is required', 403);
          invariant(
            membership.role === 'owner' ||
              membership.role === 'admin' ||
              (membership.role === 'contributor' && message.authorId === context.actorId),
            'permission.denied',
            'Message revision history is not available',
            403,
          );
          return {
            data: message.revisions.map((revision) => ({
              createdAt: revision.createdAt,
              editorId: revision.editorId,
              id: revision.id,
              text: revision.text,
            })),
            view: {
              bindings: { revisions: '$result' },
              commands: [],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: `${channel.title} Message Revisions`,
            },
          };
        },
      }),
    ];
  }

  async #requireTableRecord(channelId: string, recordId: string): Promise<TableRecord> {
    const record = await this.store.getTableRecord(recordId);
    invariant(
      record?.channelId === channelId,
      'table.record-not-found',
      'Table Record does not exist',
      404,
    );
    return record;
  }

  async #requireDictionaryEntry(
    channelId: string,
    entryId: string,
  ): Promise<DictionaryEntry> {
    const entry = await this.store.getDictionaryEntry(entryId);
    invariant(
      entry?.channelId === channelId,
      'dictionary.entry-not-found',
      'Dictionary Entry does not exist',
      404,
    );
    return entry;
  }

  async #resolveReference(
    actorId: string,
    channelId: string,
    recordId?: string,
  ): Promise<JsonValue> {
    const channel = await this.store.getChannel(channelId);
    const membership = await this.store.getMembership(channelId, actorId);
    if (
      !channel ||
      channel.deletedAt !== undefined ||
      channel.purgedAt !== undefined ||
      !membership
    ) {
      return { channelId, ...(recordId ? { recordId } : {}), status: 'unresolved' };
    }
    if (recordId !== undefined) {
      const record = await this.store.getTableRecord(recordId);
      if (
        !record ||
        record.channelId !== channelId ||
        record.tombstonedAt !== undefined
      ) {
        return { channelId, recordId, status: 'unresolved' };
      }
    }
    return { channelId, ...(recordId ? { recordId } : {}), status: 'resolved' };
  }

  async #validatedRecordValues(
    actorId: string,
    fields: readonly TableField[],
    records: readonly TableRecord[],
    input: Readonly<Record<string, JsonValue>>,
    currentRecordId?: string,
    validateReferenceTargets = true,
  ): Promise<Record<string, JsonValue>> {
    const fieldByKey = new Map(fields.map((field) => [field.key, field]));
    for (const key of Object.keys(input)) {
      invariant(
        fieldByKey.has(key),
        'table.record-unknown-field',
        `Unknown Field: ${key}`,
      );
    }
    const values: Record<string, JsonValue> = {};
    for (const field of fields) {
      const supplied = input[field.key];
      const value = supplied === undefined ? field.defaultValue : supplied;
      if (value === undefined || value === null) {
        invariant(
          !field.required,
          'table.record-required-field',
          `Required Field is missing: ${field.key}`,
        );
        if (value === null) values[field.key] = null;
        continue;
      }
      this.#validateFieldValue(field, value);
      invariant(
        !(
          field.required &&
          field.type === 'record-reference' &&
          field.cardinality === 'many' &&
          Array.isArray(value) &&
          value.length === 0
        ),
        'table.record-required-field',
        `Required Field is missing: ${field.key}`,
      );
      if (validateReferenceTargets) {
        await this.#validateRecordReferenceTargets(actorId, field, value);
      }
      if (field.unique) {
        invariant(
          !records.some(
            (record) =>
              record.id !== currentRecordId &&
              record.tombstonedAt === undefined &&
              JSON.stringify(record.values[field.key]) === JSON.stringify(value),
          ),
          'table.record-unique-field',
          `Unique Field value already exists: ${field.key}`,
          409,
        );
      }
      values[field.key] = value;
    }
    return values;
  }

  #validateFieldValue(field: TableField, rawValue: unknown): JsonValue {
    const value = toJson(rawValue);
    switch (field.type) {
      case 'text':
        invariant(typeof value === 'string', 'table.field-type', 'Expected text value');
        return value;
      case 'number':
        invariant(
          typeof value === 'number' && Number.isFinite(value),
          'table.field-type',
          'Expected finite number value',
        );
        return value;
      case 'boolean':
        invariant(typeof value === 'boolean', 'table.field-type', 'Expected boolean value');
        return value;
      case 'date-time':
        invariant(
          typeof value === 'string' && z.iso.datetime({ offset: true }).safeParse(value).success,
          'table.field-type',
          'Expected ISO date-time value',
        );
        return value;
      case 'dictionary':
        invariant(
          typeof value === 'string',
          'table.field-type',
          `Expected stable identity for ${field.type} value`,
        );
        return value;
      case 'record-reference':
        invariant(
          field.cardinality === 'one'
            ? typeof value === 'string'
            : Array.isArray(value) && value.every((item) => typeof item === 'string'),
          'table.field-reference-cardinality',
          `Expected ${field.cardinality ?? 'configured'} Record Reference value`,
        );
        if (Array.isArray(value)) {
          invariant(
            new Set(value).size === value.length,
            'table.field-reference-duplicate',
            'Record Reference values must be unique',
          );
        }
        return value;
      default:
        throw new DatagramError(
          'table.field-type',
          `Unsupported Field type: ${String(field.type)}`,
        );
    }
  }

  async #validateRecordReferenceTargets(
    actorId: string,
    field: TableField,
    value: JsonValue,
  ): Promise<void> {
    if (field.type !== 'record-reference') return;
    invariant(
      field.targetChannelId !== undefined && field.cardinality !== undefined,
      'table.field-reference-configuration',
      'Record Reference Field is not configured',
    );
    const channel = await this.store.getChannel(field.targetChannelId);
    const membership = await this.store.getMembership(field.targetChannelId, actorId);
    invariant(
      channel?.typeId === 'table' &&
        channel.deletedAt === undefined &&
        channel.purgedAt === undefined &&
        membership !== null,
      'table.record-reference-invalid',
      'Record Reference target is unavailable',
    );
    const recordIds: readonly string[] =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((recordId): recordId is string => typeof recordId === 'string')
          : [];
    for (const recordId of recordIds) {
      const record = await this.store.getTableRecord(recordId);
      invariant(
        record?.channelId === field.targetChannelId && record.tombstonedAt === undefined,
        'table.record-reference-invalid',
        'Record Reference target is unavailable',
      );
    }
  }

  async #resolveRecordReferenceValues(
    actorId: string,
    fields: readonly TableField[],
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<Record<string, JsonValue>> {
    const resolved: Record<string, JsonValue> = { ...values };
    for (const field of fields) {
      if (field.type !== 'record-reference' || field.targetChannelId === undefined) continue;
      const value = values[field.key];
      if (typeof value === 'string') {
        resolved[field.key] = await this.#resolveReference(
          actorId,
          field.targetChannelId,
          value,
        );
      } else if (Array.isArray(value)) {
        resolved[field.key] = await Promise.all(
          value.map((recordId) =>
            this.#resolveReference(actorId, field.targetChannelId!, String(recordId)),
          ),
        );
      }
    }
    return resolved;
  }
}
