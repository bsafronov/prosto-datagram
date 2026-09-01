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
  ChartDefinition,
  ChartPresentation,
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
import { ActionRegistry, QueryRegistry, defineAction, defineQuery } from './contracts';
import type { ExecutionContext } from './contracts';
import { ResultHandleBroker, transformResult } from './result-handles';
import type {
  DataViewQueryDefinition,
  DurableResultDefinition,
  IssuedResultHandle,
  ResultHandleComposition,
  ResultHandleTransform,
} from './result-handles';

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

const chartFilterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['contains', 'equals', 'greater-than', 'is-empty', 'less-than']),
  value: optionalJsonValueSchema,
});

const chartAggregationSchema = z.object({
  as: z.string().trim().min(1).max(120),
  field: z.string().min(1).optional(),
  operator: z.enum(['average', 'count', 'maximum', 'minimum', 'sum']),
});

const chartPresentationSchema = z.object({
  categoryField: z.string().min(1).optional(),
  series: z.array(z.string().min(1)).min(1),
  type: z.enum(['bar', 'line', 'pie']),
});

const fieldConversionResolutionSchema = z.object({
  kind: z.enum(['correct', 'map', 'null']),
  recordId: z.string().min(1),
  value: optionalJsonValueSchema,
});

const fieldDefaultConversionResolutionSchema = z.object({
  kind: z.enum(['correct', 'map', 'null']),
  value: optionalJsonValueSchema,
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
    purpose = name,
  ): Promise<IssuedResultHandle> {
    let result: QueryResult;
    try {
      result = await this.executeQuery(actorId, origin, name, input);
    } catch (error) {
      if (error instanceof DatagramError) {
        throw new DatagramError(error.code, 'Agent Query could not be prepared', error.status);
      }
      throw new DatagramError(
        'agent-query.failed',
        'Agent Query could not be prepared',
        500,
      );
    }
    const sourceInput = structuredClone(input);
    return this.handles.issue(
      actorId,
      purpose,
      { input: sourceInput, queryName: name },
      result,
      () => this.executeQuery(actorId, origin, name, sourceInput),
    );
  }

  async reopenDataView(
    actorId: string,
    origin: OperationOrigin,
    definition: DataViewQueryDefinition,
  ): Promise<IssuedResultHandle> {
    return this.prepareQuery(
      actorId,
      origin,
      definition.queryName,
      definition.input,
      definition.purpose,
    );
  }

  async composeResultHandle(
    actorId: string,
    composition: ResultHandleComposition,
  ): Promise<IssuedResultHandle> {
    await this.#requirePerson(actorId);
    return this.handles.compose(this.handles.serviceId, actorId, composition);
  }

  async consumeResultHandle(
    actorId: string,
    handleId: string,
    purpose: string,
  ): Promise<QueryResult> {
    await this.#requirePerson(actorId);
    return this.handles.consume(this.handles.serviceId, actorId, handleId, purpose);
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
  ): Promise<ChannelRole> {
    const membership = await this.store.getMembership(channelId, actorId);
    invariant(membership, 'permission.denied', 'Channel membership is required', 403);
    invariant(
      roleRank[membership.role] >= roleRank[minimum],
      'permission.denied',
      `Channel Role ${minimum} is required`,
      403,
    );
    return membership.role;
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
    return {
      action,
      operationId,
      ...(subject === undefined ? {} : { subject }),
    };
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
        inputSchema: z.object({
          displayName: z.string().trim().min(1).max(120),
        }),
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
            () => [
              {
                deactivatedAt,
                kind: 'person.deactivated',
                personId: input.personId,
              },
            ],
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
                membership: {
                  channelId,
                  personId: context.actorId,
                  role: 'owner',
                },
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
          const current = await this.store.getChannelNavigation(input.channelId, context.actorId);
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
          const current = await this.store.getChannelNavigation(input.channelId, context.actorId);
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
            activityId === undefined ? current : { ...current, lastReadActivityId: activityId };
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
          return this.#commit(context, 'channel.group.update', undefined, () => [
            { group, kind: 'channel-group.updated' },
          ]);
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
              ...(newPerson ? ([{ kind: 'person.created', person: newPerson }] as const) : []),
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
        description: 'Undo a reversible Operation only while its effects remain current.',
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
            !operations.some(
              (operation) =>
                operation.action === 'operation.undo' &&
                operation.changes.some(
                  (change) =>
                    'revertedOperationId' in change && change.revertedOperationId === original.id,
                ),
            ),
            'operation.already-undone',
            'Operation was already undone',
            409,
          );
          let reversed: DomainChange[];
          if (original.action === 'channel.member.grant') {
            const granted = original.changes.find((change) => change.kind === 'membership.granted');
            invariant(
              granted?.kind === 'membership.granted',
              'operation.not-reversible',
              'Operation has no reversible membership change',
              409,
            );
            reversed = [
              {
                channelId: granted.membership.channelId,
                expectedRole: granted.membership.role,
                kind: 'membership.reverted',
                personId: granted.membership.personId,
                revertedOperationId: original.id,
                ...(granted.previousRole ? { restoredRole: granted.previousRole } : {}),
              },
            ];
          } else if (original.action === 'table.record.edit') {
            const updates = original.changes.filter(
              (change) => change.kind === 'table.record-updated',
            );
            invariant(
              updates.length > 0 && updates.every((change) => change.previousValues !== undefined),
              'operation.not-reversible',
              'Operation has no reversible Record change',
              409,
            );
            reversed = [];
            for (const update of updates) {
              const record = await this.#requireTableRecord(input.channelId, update.recordId);
              const expectedVersions = Object.fromEntries(
                Object.entries(update.expectedVersions ?? {}).map(([key, version]) => [
                  key,
                  version + 1,
                ]),
              );
              invariant(
                Object.entries(expectedVersions).every(
                  ([key, version]) => (record.fieldVersions[key] ?? 0) === version,
                ),
                'operation.undo-conflict',
                'Table Record changed after original Operation',
                409,
              );
              reversed.push({
                expectedVersions,
                kind: 'table.record-updated',
                recordId: update.recordId,
                removedKeys: update
                  .previousValues!.filter((entry) => !entry.existed)
                  .map((entry) => entry.key),
                revertedOperationId: original.id,
                updatedAt: nowIso(),
                values: Object.fromEntries(
                  update
                    .previousValues!.filter((entry) => entry.existed)
                    .map((entry) => [entry.key, entry.value!]),
                ),
              });
            }
          } else if (original.action === 'table.record.create') {
            const created = original.changes.find(
              (change) => change.kind === 'table.record-created',
            );
            invariant(
              created?.kind === 'table.record-created',
              'operation.not-reversible',
              'Operation has no created Record',
              409,
            );
            const record = await this.#requireTableRecord(input.channelId, created.record.id);
            invariant(
              record.tombstonedAt === undefined &&
                record.updatedAt === undefined &&
                Object.values(record.fieldVersions).every((version) => version === 1),
              'operation.undo-conflict',
              'Table Record changed after original Operation',
              409,
            );
            reversed = [
              {
                actorId: context.actorId,
                expectedUpdatedAt: null,
                kind: 'table.record-tombstoned',
                recordId: record.id,
                revertedOperationId: original.id,
                tombstonedAt: nowIso(),
              },
            ];
          } else if (original.action === 'table.record.tombstone') {
            const tombstoned = original.changes.find(
              (change) => change.kind === 'table.record-tombstoned',
            );
            invariant(
              tombstoned?.kind === 'table.record-tombstoned',
              'operation.not-reversible',
              'Operation has no tombstoned Record',
              409,
            );
            const record = await this.#requireTableRecord(input.channelId, tombstoned.recordId);
            invariant(
              record.tombstonedAt === tombstoned.tombstonedAt,
              'operation.undo-conflict',
              'Table Record lifecycle changed after original Operation',
              409,
            );
            reversed = [
              {
                expectedTombstonedAt: tombstoned.tombstonedAt,
                kind: 'table.record-restored',
                recordId: record.id,
                revertedOperationId: original.id,
                restoredAt: nowIso(),
              },
            ];
          } else if (original.action === 'table.record.restore') {
            const restored = original.changes.find(
              (change) => change.kind === 'table.record-restored',
            );
            invariant(
              restored?.kind === 'table.record-restored',
              'operation.not-reversible',
              'Operation has no restored Record',
              409,
            );
            const record = await this.#requireTableRecord(input.channelId, restored.recordId);
            invariant(
              record.tombstonedAt === undefined && record.updatedAt === restored.restoredAt,
              'operation.undo-conflict',
              'Table Record lifecycle changed after original Operation',
              409,
            );
            reversed = [
              {
                actorId: context.actorId,
                expectedUpdatedAt: restored.restoredAt,
                kind: 'table.record-tombstoned',
                recordId: record.id,
                revertedOperationId: original.id,
                tombstonedAt: nowIso(),
              },
            ];
          } else if (
            original.action === 'table.field.add' ||
            original.action === 'table.field.tombstone' ||
            original.action === 'table.field.restore' ||
            original.action === 'table.field.convert'
          ) {
            const fieldChange = original.changes.find(
              (change) => change.kind === 'table.field-updated',
            );
            const added = original.changes.find((change) => change.kind === 'table.field-added');
            invariant(
              fieldChange?.kind === 'table.field-updated' || added?.kind === 'table.field-added',
              'operation.not-reversible',
              'Operation has no reversible schema change',
              409,
            );
            const currentField = await this.#requireTableField(
              input.channelId,
              fieldChange?.field.id ?? added!.field.id,
            );
            const expectedFieldVersion = fieldChange?.field.version ?? added!.field.version;
            invariant(
              currentField.version === expectedFieldVersion,
              'operation.undo-conflict',
              'Table Field changed after original Operation',
              409,
            );
            const currentDisplayFieldId = await this.store.getTableDisplayFieldId(input.channelId);
            if (added?.kind === 'table.field-added') {
              invariant(
                currentDisplayFieldId !== added.field.id,
                'operation.undo-conflict',
                'Table display configuration changed after original Operation',
                409,
              );
              const records = await this.store.listTableRecords(input.channelId);
              invariant(
                records.every((record) => (record.fieldVersions[added.field.key] ?? 0) <= 1),
                'operation.undo-conflict',
                'Table Field values changed after original Operation',
                409,
              );
              reversed = [
                {
                  expectedVersion: currentField.version,
                  field: {
                    ...currentField,
                    tombstonedAt: nowIso(),
                    tombstonedBy: context.actorId,
                    version: currentField.version + 1,
                  },
                  kind: 'table.field-updated',
                  previousField: currentField,
                  revertedOperationId: original.id,
                },
              ];
            } else {
              invariant(
                fieldChange?.kind === 'table.field-updated',
                'operation.not-reversible',
                'Operation has no reversible schema change',
                409,
              );
              if (original.action === 'table.field.restore') {
                invariant(
                  currentDisplayFieldId !== fieldChange.field.id,
                  'operation.undo-conflict',
                  'Table display configuration changed after original Operation',
                  409,
                );
              }
              const restoredDisplay =
                original.action === 'table.field.tombstone' &&
                original.changes.some(
                  (change) =>
                    change.kind === 'table.display-field-set' &&
                    change.displayFieldId === undefined,
                );
              if (restoredDisplay) {
                invariant(
                  currentDisplayFieldId === null,
                  'operation.undo-conflict',
                  'Table display configuration changed after original Operation',
                  409,
                );
              }
              reversed = [
                {
                  expectedVersion: currentField.version,
                  field: {
                    ...fieldChange.previousField,
                    version: currentField.version + 1,
                  },
                  kind: 'table.field-updated',
                  previousField: currentField,
                  revertedOperationId: original.id,
                },
              ];
              if (restoredDisplay) {
                reversed.push({
                  channelId: input.channelId,
                  displayFieldId: fieldChange.field.id,
                  kind: 'table.display-field-set',
                });
              }
              for (const update of original.changes.filter(
                (change) => change.kind === 'table.record-updated',
              )) {
                if (!update.previousValues) continue;
                const record = await this.#requireTableRecord(input.channelId, update.recordId);
                const expectedVersions = Object.fromEntries(
                  Object.entries(update.expectedVersions ?? {}).map(([key, version]) => [
                    key,
                    version + 1,
                  ]),
                );
                invariant(
                  Object.entries(expectedVersions).every(
                    ([key, version]) => (record.fieldVersions[key] ?? 0) === version,
                  ),
                  'operation.undo-conflict',
                  'Table Record changed after original Operation',
                  409,
                );
                reversed.push({
                  expectedVersions,
                  kind: 'table.record-updated',
                  recordId: update.recordId,
                  removedKeys: update.previousValues
                    .filter((entry) => !entry.existed)
                    .map((entry) => entry.key),
                  revertedOperationId: original.id,
                  updatedAt: nowIso(),
                  values: Object.fromEntries(
                    update.previousValues
                      .filter((entry) => entry.existed)
                      .map((entry) => [entry.key, entry.value!]),
                  ),
                });
              }
              const reversedField = reversed.find(
                (change) => change.kind === 'table.field-updated',
              );
              if (
                reversedField?.kind === 'table.field-updated' &&
                reversedField.field.tombstonedAt === undefined
              ) {
                const currentRecords = await this.store.listTableRecords(input.channelId);
                const reversedRecords = currentRecords.map((record) => {
                  const update = reversed.find(
                    (change) =>
                      change.kind === 'table.record-updated' &&
                      change.recordId === record.id,
                  );
                  if (update?.kind !== 'table.record-updated') return record;
                  const values = { ...record.values, ...update.values };
                  for (const key of update.removedKeys ?? []) delete values[key];
                  return { ...record, values };
                });
                const reversedFields = (
                  await this.store.listTableFields(input.channelId)
                ).map((field) =>
                  field.id === reversedField.field.id ? reversedField.field : field,
                );
                for (const record of reversedRecords.filter(
                  (candidate) => candidate.tombstonedAt === undefined,
                )) {
                  await this.#validatedRecordValues(
                    context.actorId,
                    reversedFields,
                    reversedRecords,
                    record.values,
                    record.id,
                    true,
                    new Set(),
                  );
                }
              }
            }
          } else {
            throw new DatagramError('operation.not-reversible', 'Operation is not reversible', 409);
          }
          return this.#commit(
            context,
            'operation.undo',
            input.channelId,
            (operationId, occurredAt) => [
              ...reversed,
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
          const isDictionary = input.type === 'dictionary';
          const isRecordReference = input.type === 'record-reference';
          invariant(
            isRecordReference
              ? input.targetChannelId !== undefined && input.cardinality !== undefined
              : input.cardinality === undefined,
            'table.field-reference-configuration',
            'Record Reference Field requires one target Channel and cardinality',
          );
          invariant(
            isDictionary
              ? input.targetChannelId !== undefined
              : isRecordReference || input.targetChannelId === undefined,
            'table.field-dictionary-configuration',
            'Dictionary Field requires one target Dictionary Channel',
          );
          if (isRecordReference) {
            await this.#requireChannel(input.targetChannelId!, 'table');
            await this.#requireRole(context.actorId, input.targetChannelId!, 'viewer');
          } else if (isDictionary) {
            await this.#requireChannel(input.targetChannelId!, 'dictionary');
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
                version: 1,
              };
              this.#validateFieldValue(candidateField, input.defaultValue);
              await this.#validateRecordReferenceTargets(
                context.actorId,
                candidateField,
                input.defaultValue,
              );
              await this.#validateDictionaryEntry(
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
            ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
            id: newId('field'),
            key: input.key,
            label: input.label,
            required: input.required,
            ...(input.targetChannelId === undefined
              ? {}
              : { targetChannelId: input.targetChannelId }),
            type: input.type,
            unique: input.unique,
            version: 1,
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
                    expectedVersions: { [input.key]: 0 },
                    kind: 'table.record-updated' as const,
                    recordId: record.id,
                    updatedAt: occurredAt,
                    values: { [input.key]: input.defaultValue! },
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
        description: 'Tombstone one Table Field while retaining its definition and values.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          fieldId: z.string().min(1),
          observedVersion: z.number().int().positive(),
        }),
        name: 'table.field.tombstone',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const field = await this.#requireTableField(input.channelId, input.fieldId);
          invariant(
            field.tombstonedAt === undefined,
            'table.field-already-tombstoned',
            'Table Field is already tombstoned',
            409,
          );
          invariant(
            field.version === input.observedVersion,
            'table.field-conflict',
            'Table Field changed after observation',
            409,
          );
          const occurredAt = nowIso();
          const next: TableField = {
            ...field,
            tombstonedAt: occurredAt,
            tombstonedBy: context.actorId,
            version: field.version + 1,
          };
          const displayFieldId = await this.store.getTableDisplayFieldId(input.channelId);
          return this.#commit(
            context,
            'table.field.tombstone',
            input.channelId,
            (operationId) => [
              {
                expectedVersion: field.version,
                field: next,
                kind: 'table.field-updated',
                previousField: field,
              },
              ...(displayFieldId === field.id
                ? [
                    {
                      channelId: input.channelId,
                      kind: 'table.display-field-set' as const,
                    },
                  ]
                : []),
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
        description: 'Restore one tombstoned Table Field and its retained values.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          fieldId: z.string().min(1),
          observedVersion: z.number().int().positive(),
        }),
        name: 'table.field.restore',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const field = await this.#requireTableField(input.channelId, input.fieldId);
          invariant(
            field.tombstonedAt !== undefined,
            'table.field-not-tombstoned',
            'Table Field is not tombstoned',
            409,
          );
          invariant(
            field.version === input.observedVersion,
            'table.field-conflict',
            'Table Field changed after observation',
            409,
          );
          const { tombstonedAt: _at, tombstonedBy: _by, ...active } = field;
          const next: TableField = { ...active, version: field.version + 1 };
          const fields = (await this.store.listTableFields(input.channelId)).map((candidate) =>
            candidate.id === field.id ? next : candidate,
          );
          const records = await this.store.listTableRecords(input.channelId);
          for (const record of records.filter(
            (candidate) => candidate.tombstonedAt === undefined,
          )) {
            await this.#validatedRecordValues(
              context.actorId,
              fields,
              records,
              record.values,
              record.id,
              true,
              new Set(),
            );
          }
          const occurredAt = nowIso();
          return this.#commit(
            context,
            'table.field.restore',
            input.channelId,
            (operationId) => [
              {
                expectedVersion: field.version,
                field: next,
                kind: 'table.field-updated',
                previousField: field,
              },
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
        description: 'Permanently purge one tombstoned Table Field and its retained values.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          fieldId: z.string().min(1),
          observedVersion: z.number().int().positive(),
        }),
        name: 'table.field.purge',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const field = await this.#requireTableField(input.channelId, input.fieldId);
          invariant(
            field.tombstonedAt !== undefined,
            'table.field-not-tombstoned',
            'Table Field must be tombstoned before purge',
            409,
          );
          invariant(
            field.version === input.observedVersion,
            'table.field-conflict',
            'Table Field changed after observation',
            409,
          );
          const occurredAt = nowIso();
          return this.#commit(context, 'table.field.purge', input.channelId, (operationId) => [
            {
              channelId: input.channelId,
              expectedVersion: field.version,
              fieldId: field.id,
              fieldKey: field.key,
              kind: 'table.field-purged',
            },
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
          ]);
        },
      }),
      defineAction({
        description: 'Convert a Table Field only after resolving every incompatible value.',
        inputSchema: z.object({
          cardinality: recordReferenceCardinalitySchema.optional(),
          cancel: z.boolean().default(false),
          channelId: z.string().min(1),
          defaultResolution: fieldDefaultConversionResolutionSchema.optional(),
          fieldId: z.string().min(1),
          observedVersion: z.number().int().positive(),
          resolutions: z.array(fieldConversionResolutionSchema).default([]),
          targetChannelId: z.string().min(1).optional(),
          targetType: tableFieldTypeSchema,
        }),
        name: 'table.field.convert',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const field = await this.#requireTableField(input.channelId, input.fieldId);
          invariant(
            field.tombstonedAt === undefined,
            'table.field-tombstoned',
            'Table Field is tombstoned',
            409,
          );
          invariant(
            field.version === input.observedVersion,
            'table.field-conflict',
            'Table Field changed after observation',
            409,
          );
          invariant(
            field.type !== input.targetType,
            'table.field-type-unchanged',
            'Target Field type must differ',
            409,
          );
          const isDictionary = input.targetType === 'dictionary';
          const isRecordReference = input.targetType === 'record-reference';
          invariant(
            isRecordReference
              ? input.targetChannelId !== undefined && input.cardinality !== undefined
              : input.cardinality === undefined,
            'table.field-reference-configuration',
            'Record Reference Field requires one target Channel and cardinality',
          );
          invariant(
            isDictionary
              ? input.targetChannelId !== undefined
              : isRecordReference || input.targetChannelId === undefined,
            'table.field-dictionary-configuration',
            'Dictionary Field requires one target Dictionary Channel',
          );
          if (isRecordReference) {
            await this.#requireChannel(input.targetChannelId!, 'table');
            await this.#requireRole(context.actorId, input.targetChannelId!, 'viewer');
          } else if (isDictionary) {
            await this.#requireChannel(input.targetChannelId!, 'dictionary');
            await this.#requireRole(context.actorId, input.targetChannelId!, 'viewer');
          }
          const {
            cardinality: _previousCardinality,
            targetChannelId: _previousTargetChannelId,
            ...fieldWithoutReference
          } = field;
          const convertedField: TableField = {
            ...fieldWithoutReference,
            ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
            ...(input.targetChannelId === undefined
              ? {}
              : { targetChannelId: input.targetChannelId }),
            type: input.targetType,
          };
          const occurredAt = nowIso();
          if (input.cancel) {
            invariant(
              input.resolutions.length === 0 && input.defaultResolution === undefined,
              'table.field-conversion-cancelled',
              'Cancelled conversion cannot include resolutions',
            );
            return this.#commit(context, 'table.field.convert', input.channelId, () => [], {
              id: field.id,
              kind: 'field',
            });
          }
          const records = await this.store.listTableRecords(input.channelId);
          const failures = (
            await Promise.all(
              records.map(async (record) => {
                const value = record.values[field.key];
                return value !== undefined &&
                  value !== null &&
                  !(await this.#fieldAccepts(context.actorId, convertedField, value))
                  ? record
                  : null;
              }),
            )
          ).filter((record): record is TableRecord => record !== null);
          const defaultFails =
            field.defaultValue !== undefined &&
            field.defaultValue !== null &&
            !(await this.#fieldAccepts(context.actorId, convertedField, field.defaultValue));
          invariant(
            defaultFails === (input.defaultResolution !== undefined),
            'table.field-conversion-default-unresolved',
            defaultFails
              ? 'Incompatible default value needs one explicit resolution'
              : 'Default resolution does not match an incompatible default',
            409,
          );
          let nextDefault = field.defaultValue;
          if (input.defaultResolution !== undefined) {
            if (input.defaultResolution.kind === 'null') {
              invariant(
                !field.required,
                'table.field-conversion-null-required',
                'Required Field cannot be explicitly nulled',
              );
              invariant(
                input.defaultResolution.value === undefined,
                'table.field-conversion-resolution-invalid',
                'Null resolution cannot include a value',
              );
              nextDefault = null;
            } else {
              invariant(
                input.defaultResolution.value !== undefined &&
                  input.defaultResolution.value !== null,
                'table.field-conversion-resolution-required',
                'Correction or mapping needs a replacement value',
              );
              const value = this.#validateFieldValue(
                convertedField,
                input.defaultResolution.value,
              );
              invariant(
                await this.#fieldAccepts(context.actorId, convertedField, value),
                'table.field-conversion-resolution-invalid',
                'Replacement value is incompatible with target Field',
              );
              nextDefault = value;
            }
          }
          const resolutions = new Map(
            input.resolutions.map((resolution) => [resolution.recordId, resolution]),
          );
          invariant(
            resolutions.size === input.resolutions.length,
            'table.field-conversion-resolution-duplicate',
            'Each Record may have one conversion resolution',
          );
          invariant(
            failures.every((record) => resolutions.has(record.id)) &&
              resolutions.size === failures.length,
            'table.field-conversion-unresolved',
            'Every incompatible value needs one explicit resolution',
            409,
          );
          const updates = await Promise.all(failures.map(async (record) => {
            const resolution = resolutions.get(record.id)!;
            let value: JsonValue;
            if (resolution.kind === 'null') {
              invariant(
                !field.required,
                'table.field-conversion-null-required',
                'Required Field cannot be explicitly nulled',
              );
              invariant(
                resolution.value === undefined,
                'table.field-conversion-resolution-invalid',
                'Null resolution cannot include a value',
              );
              value = null;
            } else {
              invariant(
                resolution.value !== undefined && resolution.value !== null,
                'table.field-conversion-resolution-required',
                'Correction or mapping needs a replacement value',
              );
              value = this.#validateFieldValue(
                convertedField,
                resolution.value,
              );
              invariant(
                await this.#fieldAccepts(context.actorId, convertedField, value),
                'table.field-conversion-resolution-invalid',
                'Replacement value is incompatible with target Field',
              );
            }
            return { record, value };
          }));
          const next: TableField = {
            ...convertedField,
            ...(nextDefault === undefined ? {} : { defaultValue: nextDefault }),
            version: field.version + 1,
          };
          const nextFields = (await this.store.listTableFields(input.channelId)).map((candidate) =>
            candidate.id === field.id ? next : candidate,
          );
          const nextRecords = records.map((record) => {
            const update = updates.find((candidate) => candidate.record.id === record.id);
            return update
              ? {
                  ...record,
                  values: { ...record.values, [field.key]: update.value },
                }
              : record;
          });
          for (const record of nextRecords.filter(
            (candidate) => candidate.tombstonedAt === undefined,
          )) {
            await this.#validatedRecordValues(
              context.actorId,
              nextFields,
              nextRecords,
              record.values,
              record.id,
              true,
              new Set([field.key]),
            );
          }
          return this.#commit(
            context,
            'table.field.convert',
            input.channelId,
            (operationId) => [
              {
                expectedVersion: field.version,
                field: next,
                kind: 'table.field-updated',
                previousField: field,
              },
              ...updates.map(({ record, value }) => ({
                expectedVersions: {
                  [field.key]: record.fieldVersions[field.key] ?? 0,
                },
                kind: 'table.record-updated' as const,
                previousValues: [
                  {
                    existed: true,
                    key: field.key,
                    value: record.values[field.key]!,
                  },
                ],
                recordId: record.id,
                updatedAt: occurredAt,
                values: { [field.key]: value },
              })),
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
                  fieldVersions: Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
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
        description: 'Select a Text or Dictionary Field as the Table Display Field. Admin role required.',
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
              field.tombstonedAt === undefined,
              'table.field-tombstoned',
              'Display Field is tombstoned',
              409,
            );
            invariant(
              field.type === 'text' || field.type === 'dictionary',
              'table.display-field-type',
              'Display Field must be Text or Dictionary',
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
          observedVersions: z.record(z.string(), z.number().int().nonnegative()),
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
          const changedKeys = Object.keys(input.values);
          invariant(
            changedKeys.length > 0,
            'table.record-empty-edit',
            'Table Record edit needs at least one Field',
          );
          invariant(
            changedKeys.every((key) => input.observedVersions[key] !== undefined),
            'table.record-observed-version-required',
            'Observed version is required for every edited Field',
          );
          for (const key of changedKeys) {
            invariant(
              (record.fieldVersions[key] ?? 0) === input.observedVersions[key],
              'table.record-edit-conflict',
              `Table Field value changed after observation: ${key}`,
              409,
            );
          }
          const fields = await this.store.listTableFields(input.channelId);
          const records = await this.store.listTableRecords(input.channelId);
          const values = await this.#validatedRecordValues(
            context.actorId,
            fields,
            records,
            { ...record.values, ...input.values },
            record.id,
            true,
            new Set(Object.keys(input.values)),
          );
          const updatedAt = nowIso();
          return this.#commit(
            context,
            'table.record.edit',
            input.channelId,
            (operationId) => [
              {
                expectedVersions: Object.fromEntries(
                  changedKeys.map((key) => [key, input.observedVersions[key]!]),
                ),
                kind: 'table.record-updated',
                previousValues: changedKeys.map((key) => ({
                  existed: Object.hasOwn(record.values, key),
                  key,
                  ...(Object.hasOwn(record.values, key) ? { value: record.values[key] } : {}),
                })),
                recordId: record.id,
                updatedAt,
                values: Object.fromEntries(changedKeys.map((key) => [key, values[key]!])),
              },
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
        inputSchema: z.object({
          channelId: z.string().min(1),
          recordId: z.string().min(1),
        }),
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
                expectedUpdatedAt: record.updatedAt ?? null,
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
        inputSchema: z.object({
          channelId: z.string().min(1),
          recordId: z.string().min(1),
        }),
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
                expectedTombstonedAt: record.tombstonedAt!,
                kind: 'table.record-restored',
                recordId: record.id,
                restoredAt,
              },
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
        description: 'Create a live Chart Channel from a compatible Result Handle.',
        inputSchema: z.object({
          handleId: z.string().min(1),
          handlePurpose: z.string().min(1),
          presentation: chartPresentationSchema,
          title: z.string().trim().min(1).max(160),
        }),
        name: 'chart.create',
        run: async (context, input) => {
          const durable = await this.handles.consumeDefinition(
            this.handles.serviceId,
            context.actorId,
            input.handleId,
            input.handlePurpose,
          );
          const channelId = newId('channel');
          const definition = await this.#chartDefinitionFromResult(
            context.actorId,
            channelId,
            durable,
            {
              ...(input.presentation.categoryField === undefined
                ? {}
                : { categoryField: input.presentation.categoryField }),
              series: input.presentation.series,
              type: input.presentation.type,
            },
            1,
          );
          const type = this.channelTypes.require('chart');
          const occurredAt = nowIso();
          const channel: Channel = {
            createdAt: occurredAt,
            id: channelId,
            ownerId: context.actorId,
            title: input.title,
            typeId: type.id,
            typeVersion: type.version,
            updatedAt: occurredAt,
          };
          return this.#commit(
            context,
            'chart.create',
            channelId,
            (operationId) => [
              { channel, kind: 'channel.created' },
              {
                kind: 'membership.granted',
                membership: {
                  channelId,
                  personId: context.actorId,
                  role: 'owner',
                },
              },
              { definition, kind: 'chart.definition-set' },
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
        description: 'Replace a Chart live query and presentation definition.',
        inputSchema: z.object({
          aggregations: z.array(chartAggregationSchema).min(1),
          channelId: z.string().min(1),
          filters: z.array(chartFilterSchema).default([]),
          grouping: z.array(z.string().min(1)).default([]),
          observedVersion: z.number().int().positive(),
          presentation: chartPresentationSchema,
          sourceChannelId: z.string().min(1),
        }),
        name: 'chart.definition.update',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'chart');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const current = await this.#requireChartDefinition(input.channelId);
          invariant(
            current.version === input.observedVersion,
            'chart.definition-conflict',
            'Chart definition changed after observation',
            409,
          );
          const definition: ChartDefinition = {
            aggregations: input.aggregations.map((aggregation) => ({
              as: aggregation.as,
              ...(aggregation.field === undefined ? {} : { field: aggregation.field }),
              operator: aggregation.operator,
            })),
            channelId: input.channelId,
            filters: input.filters.map((filter) => ({
              field: filter.field,
              operator: filter.operator,
              ...(filter.value === undefined ? {} : { value: filter.value }),
            })),
            grouping: input.grouping,
            presentation: {
              ...(input.presentation.categoryField === undefined
                ? {}
                : { categoryField: input.presentation.categoryField }),
              series: input.presentation.series,
              type: input.presentation.type,
            },
            sourceChannelId: input.sourceChannelId,
            version: current.version + 1,
          };
          await this.#validateChartDefinition(context.actorId, definition);
          const occurredAt = nowIso();
          return this.#commit(
            context,
            'chart.definition.update',
            input.channelId,
            (operationId) => [
              {
                definition,
                expectedVersion: current.version,
                kind: 'chart.definition-set',
              },
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  'chart.definition-changed',
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.channelId, kind: 'channel' },
          );
        },
      }),
      defineAction({
        description: 'Record an explicit meaningful Chart event.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          kind: z.enum(['insight', 'report', 'threshold']),
        }),
        name: 'chart.event.record',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId, 'chart');
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const occurredAt = nowIso();
          const activityKind = {
            insight: 'chart.insight-produced',
            report: 'chart.report-produced',
            threshold: 'chart.threshold-crossed',
          }[input.kind]!;
          return this.#commit(
            context,
            'chart.event.record',
            input.channelId,
            (operationId) => [
              {
                activity: this.#activity(
                  context.actorId,
                  input.channelId,
                  activityKind,
                  operationId,
                  occurredAt,
                ),
                kind: 'activity.appended',
              },
            ],
            { id: input.channelId, kind: 'channel' },
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
              bindings: { channels: '$result' },
              commands: [
                'channel.create',
                'channel.navigation.archive',
                'channel.navigation.restore',
                'channel.navigation.mute',
                'channel.navigation.pin',
                'channel.activity.mark-read',
                'channel.group.channel.add',
              ],
              kind: 'channel-list',
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
          const role = await this.#requireRole(context.actorId, input.channelId, 'viewer');
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
              commands:
                roleRank[role] >= roleRank.contributor
                  ? [
                      'dictionary.entry.create',
                      'dictionary.entry.rename',
                      'dictionary.entry.retire',
                      'dictionary.entry.restore',
                    ]
                  : [],
              kind: 'dictionary',
              schemaVersion: 'datagram/view@1',
              title: 'Dictionary Entries',
            },
          };
        },
      }),
      defineQuery({
        description: 'Describe the active Fields in a Table Channel.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          includeTombstoned: z.boolean().default(false),
        }),
        name: 'table.describe',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'table');
          const role = await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const fields = await this.store.listTableFields(input.channelId);
          return {
            data: fields
              .filter((field) => input.includeTombstoned || field.tombstonedAt === undefined)
              .map((field) => ({
                ...(field.cardinality === undefined ? {} : { cardinality: field.cardinality }),
                id: field.id,
                key: field.key,
                label: field.label,
                required: field.required,
                ...(field.targetChannelId === undefined
                  ? {}
                  : { targetChannelId: field.targetChannelId }),
                ...(field.tombstonedAt === undefined ? {} : { tombstonedAt: field.tombstonedAt }),
                type: field.type,
                unique: field.unique,
                version: field.version,
              })),
            view: {
              bindings: { fields: '$result' },
              commands: [
                ...(roleRank[role] >= roleRank.admin
                  ? [
                      'table.field.add',
                      'table.field.tombstone',
                      'table.field.restore',
                      'table.field.convert',
                      'table.field.purge',
                    ]
                  : []),
                ...(roleRank[role] >= roleRank.contributor ? ['table.record.create'] : []),
              ],
              kind: 'table-schema',
              schemaVersion: 'datagram/view@1',
              title: `${channel.title} Fields`,
            },
          };
        },
      }),
      defineQuery({
        description: 'Preview every value incompatible with a proposed Table Field type.',
        inputSchema: z.object({
          cardinality: recordReferenceCardinalitySchema.optional(),
          channelId: z.string().min(1),
          fieldId: z.string().min(1),
          targetChannelId: z.string().min(1).optional(),
          targetType: tableFieldTypeSchema,
        }),
        name: 'table.field.conversion.preview',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'admin');
          const field = await this.#requireTableField(input.channelId, input.fieldId);
          invariant(
            field.tombstonedAt === undefined,
            'table.field-tombstoned',
            'Table Field is tombstoned',
            409,
          );
          const isDictionary = input.targetType === 'dictionary';
          const isRecordReference = input.targetType === 'record-reference';
          invariant(
            isRecordReference
              ? input.targetChannelId !== undefined && input.cardinality !== undefined
              : input.cardinality === undefined,
            'table.field-reference-configuration',
            'Record Reference Field requires one target Channel and cardinality',
          );
          invariant(
            isDictionary
              ? input.targetChannelId !== undefined
              : isRecordReference || input.targetChannelId === undefined,
            'table.field-dictionary-configuration',
            'Dictionary Field requires one target Dictionary Channel',
          );
          if (isRecordReference) {
            await this.#requireChannel(input.targetChannelId!, 'table');
            await this.#requireRole(context.actorId, input.targetChannelId!, 'viewer');
          } else if (isDictionary) {
            await this.#requireChannel(input.targetChannelId!, 'dictionary');
            await this.#requireRole(context.actorId, input.targetChannelId!, 'viewer');
          }
          const {
            cardinality: _previousCardinality,
            targetChannelId: _previousTargetChannelId,
            ...fieldWithoutReference
          } = field;
          const convertedField: TableField = {
            ...fieldWithoutReference,
            ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
            ...(input.targetChannelId === undefined
              ? {}
              : { targetChannelId: input.targetChannelId }),
            type: input.targetType,
          };
          const records = await this.store.listTableRecords(input.channelId);
          return {
            data: {
              defaultFailure:
                field.defaultValue !== undefined &&
                field.defaultValue !== null &&
                !(await this.#fieldAccepts(
                  context.actorId,
                  convertedField,
                  field.defaultValue,
                ))
                  ? field.defaultValue
                  : null,
              failures: (
                await Promise.all(
                  records.map(async (record) => {
                    const value = record.values[field.key];
                    return value !== undefined &&
                      value !== null &&
                      !(await this.#fieldAccepts(context.actorId, convertedField, value))
                      ? { originalValue: value, recordId: record.id }
                      : null;
                  }),
                )
              ).filter((failure) => failure !== null),
              fieldId: field.id,
              observedVersion: field.version,
              targetType: input.targetType,
            },
            view: {
              bindings: { preview: '$result' },
              commands: ['table.field.convert'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Field Conversion Preview',
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
            data: {
              displayFieldId: await this.store.getTableDisplayFieldId(input.channelId),
            },
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
          includeTombstonedFields: z.boolean().default(false),
          includeTombstoned: z.boolean().default(false),
        }),
        name: 'table.records.list',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'table');
          const role = await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const records = (await this.store.listTableRecords(input.channelId)).filter(
            (record) => input.includeTombstoned || record.tombstonedAt === undefined,
          );
          const fields = await this.store.listTableFields(input.channelId);
          const visibleKeys = new Set(
            fields
              .filter((field) => input.includeTombstonedFields || field.tombstonedAt === undefined)
              .map((field) => field.key),
          );
          return {
            data: await Promise.all(
              records.map(async (record) => ({
                fieldVersions: Object.fromEntries(
                  Object.entries(record.fieldVersions).filter(([key]) => visibleKeys.has(key)),
                ),
                id: record.id,
                ...(record.tombstonedAt === undefined
                  ? {}
                  : { tombstonedAt: record.tombstonedAt }),
                values: await this.#resolveTableValues(
                  context.actorId,
                  fields.filter((field) => visibleKeys.has(field.key)),
                  Object.fromEntries(
                    Object.entries(record.values).filter(([key]) => visibleKeys.has(key)),
                  ),
                ),
              })),
            ),
            view: {
              bindings: { rows: '$result' },
              commands:
                roleRank[role] >= roleRank.contributor
                  ? [
                      'table.record.create',
                      'table.record.edit',
                      'table.record.tombstone',
                      'table.record.restore',
                    ]
                  : [],
              kind: 'table-records',
              schemaVersion: 'datagram/view@1',
              title: channel.title,
            },
          };
        },
      }),
      defineQuery({
        description: 'Reopen a durable Table View definition against current Records.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          viewId: z.string().min(1),
        }),
        name: 'table.view.open',
        run: async (context, input): Promise<QueryResult> => {
          await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const definition = (await this.store.listTableViews(input.channelId, context.actorId)).find(
            (view) => view.id === input.viewId,
          );
          invariant(
            definition,
            'table.view-not-found',
            'Table View does not exist or is not available',
            404,
          );
          const fields = await this.store.listTableFields(input.channelId);
          const keys = new Map(fields.map((field) => [field.id, field.key]));
          const visibleKeys = new Set(
            definition.visibleFieldIds.map((fieldId) => keys.get(fieldId)).filter(Boolean),
          );
          const records = await this.executeQuery(
            context.actorId,
            context.origin,
            'table.records.list',
            { channelId: input.channelId },
          );
          let current: QueryResult = {
            data: (records.data as JsonValue[]).map((record) => {
              if (record === null || Array.isArray(record) || typeof record !== 'object') return record;
              const values = record.values;
              return {
                ...record,
                values:
                  values !== null && !Array.isArray(values) && typeof values === 'object'
                    ? Object.fromEntries(
                        Object.entries(values).filter(([key]) => visibleKeys.has(key)),
                      )
                    : (values ?? null),
              };
            }),
            view: {
              bindings: { rows: '$result' },
              commands: [
                'table.record.create',
                'table.record.edit',
                'table.record.tombstone',
                'table.record.restore',
              ],
              kind: 'table-records',
              schemaVersion: 'datagram/view@1',
              title: definition.name,
            },
          };
          current = transformResult(current, {
            filters: definition.filters.map((filter) => ({
              field: keys.get(filter.fieldId) ?? filter.fieldId,
              operator: filter.operator,
              ...(filter.value === undefined ? {} : { value: filter.value }),
            })),
            kind: 'filter',
          });
          if (Array.isArray(current.data) && definition.sorting.length > 0) {
            const valueAt = (row: JsonValue, key: string): JsonValue | undefined => {
              if (row === null || Array.isArray(row) || typeof row !== 'object') return undefined;
              const values = row.values;
              return values !== null && !Array.isArray(values) && typeof values === 'object'
                ? values[key]
                : undefined;
            };
            current = {
              ...current,
              data: [...current.data].sort((left, right) => {
                for (const sort of definition.sorting) {
                  const key = keys.get(sort.fieldId) ?? sort.fieldId;
                  const leftValue = valueAt(left, key);
                  const rightValue = valueAt(right, key);
                  const compared = (JSON.stringify(leftValue) ?? '').localeCompare(
                    JSON.stringify(rightValue) ?? '',
                  );
                  if (compared !== 0) {
                    return sort.direction === 'ascending' ? compared : -compared;
                  }
                }
                return 0;
              }),
            };
          }
          return definition.grouping.length === 0
            ? current
            : transformResult(current, {
                fields: definition.grouping.map((fieldId) => keys.get(fieldId) ?? fieldId),
                kind: 'group',
              });
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
            data: toJson(
              views.map((view) => ({
                filters: [...view.filters],
                grouping: [...view.grouping],
                id: view.id,
                name: view.name,
                ownerId: view.ownerId,
                sorting: [...view.sorting],
                visibility: view.visibility,
                visibleFieldIds: [...view.visibleFieldIds],
              })),
            ),
            view: {
              bindings: { views: '$result' },
              commands: ['table.view.create'],
              kind: 'table-views',
              schemaVersion: 'datagram/view@1',
              title: 'Table Views',
            },
          };
        },
      }),
      defineQuery({
        description: 'Execute and render one live Chart under Chart and source permissions.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'chart.open',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'chart');
          const role = await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const definition = await this.#requireChartDefinition(input.channelId);
          await this.#validateChartDefinition(context.actorId, definition);
          let current = await this.executeQuery(
            context.actorId,
            context.origin,
            'table.records.list',
            { channelId: definition.sourceChannelId },
          );
          if (definition.filters.length > 0) {
            current = transformResult(current, {
              filters: definition.filters,
              kind: 'filter',
            });
          }
          if (definition.grouping.length > 0) {
            current = transformResult(current, {
              fields: definition.grouping,
              kind: 'group',
            });
          }
          current = transformResult(current, {
            aggregations: definition.aggregations,
            kind: 'aggregate',
          });
          return {
            data: {
              presentation: toJson(definition.presentation),
              series: current.data,
            },
            view: {
              bindings: {
                presentation: '$result.presentation',
                series: '$result.series',
              },
              commands:
                roleRank[role] >= roleRank.admin
                  ? ['chart.definition.update', 'chart.event.record']
                  : roleRank[role] >= roleRank.contributor
                    ? ['chart.event.record']
                    : [],
              kind: 'chart',
              schemaVersion: 'datagram/view@1',
              title: channel.title,
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

  async #chartDefinitionFromResult(
    actorId: string,
    channelId: string,
    durable: DurableResultDefinition,
    presentation: ChartPresentation,
    version: number,
  ): Promise<ChartDefinition> {
    invariant(
      durable.sources.length === 1 && durable.sources[0]!.queryName === 'table.records.list',
      'chart.result-handle-incompatible',
      'Result Handle must have one Table Record source',
    );
    const sourceInput = z
      .object({
        channelId: z.string().min(1),
        includeTombstoned: z.boolean().default(false),
        includeTombstonedFields: z.boolean().default(false),
      })
      .safeParse(durable.sources[0]!.input);
    invariant(
      sourceInput.success &&
        !sourceInput.data.includeTombstoned &&
        !sourceInput.data.includeTombstonedFields,
      'chart.result-handle-incompatible',
      'Result Handle must select active Table Records and Fields',
    );
    const transforms = durable.transforms.filter(
      (transform): transform is Exclude<ResultHandleTransform, { readonly kind: 'pass' }> =>
        transform.kind !== 'pass',
    );
    const kinds = transforms.map((transform) => transform.kind).join(',');
    invariant(
      /^(filter,)?(group,)?aggregate$/.test(kinds),
      'chart.result-handle-incompatible',
      'Result Handle must filter, optionally group, then aggregate once',
    );
    const filter = transforms.find((transform) => transform.kind === 'filter');
    const group = transforms.find((transform) => transform.kind === 'group');
    const aggregate = transforms.find((transform) => transform.kind === 'aggregate');
    invariant(
      aggregate?.kind === 'aggregate',
      'chart.result-handle-incompatible',
      'Result Handle must include aggregation',
    );
    const definition: ChartDefinition = {
      aggregations: aggregate.aggregations.map((aggregation) => ({
        as: aggregation.as,
        ...(aggregation.field === undefined ? {} : { field: aggregation.field }),
        operator: aggregation.operator,
      })),
      channelId,
      filters:
        filter?.kind === 'filter'
          ? filter.filters.map((candidate) => ({
              field: candidate.field,
              operator: candidate.operator,
              ...(candidate.value === undefined ? {} : { value: candidate.value }),
            }))
          : [],
      grouping: group?.kind === 'group' ? group.fields : [],
      presentation,
      sourceChannelId: sourceInput.data.channelId,
      version,
    };
    await this.#validateChartDefinition(actorId, definition);
    return definition;
  }

  async #validateChartDefinition(
    actorId: string,
    definition: ChartDefinition,
  ): Promise<void> {
    await this.#requireChannel(definition.sourceChannelId, 'table');
    await this.#requireRole(actorId, definition.sourceChannelId, 'viewer');
    const fields = (await this.store.listTableFields(definition.sourceChannelId)).filter(
      (field) => field.tombstonedAt === undefined,
    );
    const knownKeys = new Set(fields.map((field) => field.key));
    const referencedSourceFields = [
      ...definition.filters.map((filter) => filter.field),
      ...definition.grouping,
      ...definition.aggregations.flatMap((aggregation) =>
        aggregation.field === undefined ? [] : [aggregation.field],
      ),
    ];
    invariant(
      referencedSourceFields.every((field) => knownKeys.has(field)),
      'chart.definition-unknown-field',
      'Chart definition references an unknown active Table Field',
    );
    invariant(
      new Set(definition.grouping).size === definition.grouping.length,
      'chart.definition-duplicate-group',
      'Chart grouping Fields must be unique',
    );
    invariant(
      definition.aggregations.length > 0 &&
        new Set(definition.aggregations.map((aggregation) => aggregation.as)).size ===
          definition.aggregations.length,
      'chart.definition-invalid-aggregation',
      'Chart needs uniquely named aggregations',
    );
    invariant(
      definition.aggregations.every(
        (aggregation) => aggregation.operator === 'count' || aggregation.field !== undefined,
      ),
      'chart.definition-invalid-aggregation',
      'Non-count aggregation requires a source Field',
    );
    const aggregateNames = new Set(
      definition.aggregations.map((aggregation) => aggregation.as),
    );
    invariant(
      definition.presentation.series.every((series) => aggregateNames.has(series)) &&
        (definition.presentation.categoryField === undefined ||
          definition.grouping.includes(definition.presentation.categoryField)),
      'chart.presentation-invalid-binding',
      'Chart presentation must bind grouping and aggregation outputs',
    );
  }

  async #requireChartDefinition(channelId: string): Promise<ChartDefinition> {
    const definition = await this.store.getChartDefinition(channelId);
    invariant(
      definition,
      'chart.definition-not-found',
      'Chart definition does not exist',
      404,
    );
    return definition;
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

  async #requireTableField(channelId: string, fieldId: string): Promise<TableField> {
    const field = (await this.store.listTableFields(channelId)).find(
      (candidate) => candidate.id === fieldId,
    );
    invariant(field, 'table.field-not-found', 'Table Field does not exist', 404);
    return field;
  }

  async #fieldAccepts(actorId: string, field: TableField, value: JsonValue): Promise<boolean> {
    try {
      this.#validateFieldValue(field, value);
      await this.#validateRecordReferenceTargets(actorId, field, value);
      await this.#validateDictionaryEntry(actorId, field, value);
      return true;
    } catch (error) {
      if (
        error instanceof DatagramError &&
        (error.code.startsWith('table.field-') ||
          error.code === 'table.record-reference-invalid' ||
          error.code === 'table.dictionary-entry-invalid')
      ) {
        return false;
      }
      throw error;
    }
  }

  async #validatedRecordValues(
    actorId: string,
    fields: readonly TableField[],
    records: readonly TableRecord[],
    input: Readonly<Record<string, JsonValue>>,
    currentRecordId?: string,
    validateReferenceTargets = true,
    newDictionaryValueKeys?: ReadonlySet<string>,
  ): Promise<Record<string, JsonValue>> {
    const activeFields = fields.filter((field) => field.tombstonedAt === undefined);
    const allFieldByKey = new Map(fields.map((field) => [field.key, field]));
    const currentRecord = records.find((record) => record.id === currentRecordId);
    for (const key of Object.keys(input)) {
      const field = allFieldByKey.get(key);
      invariant(
        field !== undefined &&
          (field.tombstonedAt === undefined ||
            (currentRecord !== undefined &&
              JSON.stringify(input[key]) === JSON.stringify(currentRecord.values[key]))),
        'table.record-unknown-field',
        `Unknown Field: ${key}`,
      );
    }
    const values: Record<string, JsonValue> = {};
    for (const field of activeFields) {
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
        if (
          field.type === 'dictionary' &&
          (newDictionaryValueKeys === undefined || newDictionaryValueKeys.has(field.key))
        ) {
          await this.#validateDictionaryEntry(actorId, field, value);
        }
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

  async #validateDictionaryEntry(
    actorId: string,
    field: TableField,
    value: JsonValue,
  ): Promise<void> {
    if (field.type !== 'dictionary') return;
    invariant(
      field.targetChannelId !== undefined,
      'table.field-dictionary-configuration',
      'Dictionary Field is not configured',
    );
    const channel = await this.store.getChannel(field.targetChannelId);
    const membership = await this.store.getMembership(field.targetChannelId, actorId);
    const entry = typeof value === 'string' ? await this.store.getDictionaryEntry(value) : null;
    invariant(
      channel?.typeId === 'dictionary' &&
        channel.deletedAt === undefined &&
        channel.purgedAt === undefined &&
        membership !== null &&
        entry?.channelId === field.targetChannelId &&
        entry.retiredAt === undefined,
      'table.dictionary-entry-invalid',
      'Dictionary Entry is unavailable',
    );
  }

  async #resolveDictionaryEntry(
    actorId: string,
    channelId: string,
    entryId: string,
  ): Promise<JsonValue> {
    const channel = await this.store.getChannel(channelId);
    const membership = await this.store.getMembership(channelId, actorId);
    if (
      channel?.typeId !== 'dictionary' ||
      channel.deletedAt !== undefined ||
      channel.purgedAt !== undefined ||
      !membership
    ) {
      return { entryId, status: 'unresolved' };
    }
    const entry = await this.store.getDictionaryEntry(entryId);
    if (entry?.channelId !== channelId) return { entryId, status: 'unresolved' };
    return {
      entryId,
      label: entry.label,
      status: entry.retiredAt === undefined ? 'resolved' : 'retired',
    };
  }

  async #resolveTableValues(
    actorId: string,
    fields: readonly TableField[],
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<Record<string, JsonValue>> {
    const resolved: Record<string, JsonValue> = { ...values };
    for (const field of fields) {
      const value = values[field.key];
      if (
        field.type === 'dictionary' &&
        field.targetChannelId !== undefined &&
        typeof value === 'string'
      ) {
        resolved[field.key] = await this.#resolveDictionaryEntry(
          actorId,
          field.targetChannelId,
          value,
        );
        continue;
      }
      if (field.type !== 'record-reference' || field.targetChannelId === undefined) continue;
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
