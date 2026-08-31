import * as z from 'zod/v4';

import { ChannelTypeRegistry } from '../../domain/channel-types';
import { DatagramError, invariant } from '../../domain/errors';
import {
  channelRoleSchema,
  jsonValueSchema,
  newId,
  nowIso,
  tableFieldTypeSchema,
} from '../../domain/model';
import type {
  ActionReceipt,
  Channel,
  ChannelActivity,
  ChannelGroup,
  ChannelNavigation,
  ChannelInvitation,
  ChannelRole,
  DomainChange,
  JsonValue,
  Operation,
  OperationOrigin,
  Person,
  QueryResult,
  TableField,
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

  async #requireChannel(channelId: string, typeId?: string): Promise<Channel> {
    const channel = await this.store.getChannel(channelId);
    invariant(channel, 'channel.not-found', 'Channel does not exist', 404);
    if (typeId) {
      invariant(
        channel.typeId === typeId,
        'channel.type-mismatch',
        `Channel must use type ${typeId}`,
      );
    }
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
  ): ChannelActivity {
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
        description: 'Add a typed Field to a Table Channel. Admin role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          defaultValue: optionalJsonValueSchema,
          key: z.string().regex(/^[a-z][a-z0-9_]*$/),
          label: z.string().trim().min(1).max(120),
          required: z.boolean().default(false),
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
          if (input.defaultValue !== undefined) this.#validateFieldValue(input.type, input.defaultValue);
          const field: TableField = {
            channelId: input.channelId,
            ...(input.defaultValue === undefined
              ? {}
              : { defaultValue: input.defaultValue }),
            id: newId('field'),
            key: input.key,
            label: input.label,
            required: input.required,
            type: input.type,
            unique: input.unique,
          };
          return this.#commit(
            context,
            'table.field.add',
            input.channelId,
            (operationId, occurredAt) => [
              { field, kind: 'table.field-added' },
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
          const fieldByKey = new Map(fields.map((field) => [field.key, field]));
          for (const key of Object.keys(input.values)) {
            invariant(
              fieldByKey.has(key),
              'table.record-unknown-field',
              `Unknown Field: ${key}`,
            );
          }
          const values: Record<string, JsonValue> = {};
          for (const field of fields) {
            const supplied = input.values[field.key];
            const value = supplied === undefined ? field.defaultValue : supplied;
            if (value === undefined) {
              invariant(
                !field.required,
                'table.record-required-field',
                `Required Field is missing: ${field.key}`,
              );
              continue;
            }
            this.#validateFieldValue(field.type, value);
            if (field.unique) {
              invariant(
                !records.some(
                  (record) => JSON.stringify(record.values[field.key]) === JSON.stringify(value),
                ),
                'table.record-unique-field',
                `Unique Field value already exists: ${field.key}`,
                409,
              );
            }
            values[field.key] = value;
          }
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
        description: 'Post a Message in any Channel Discussion. Contributor role required.',
        inputSchema: z.object({
          channelId: z.string().min(1),
          recordReferences: z.array(z.string().min(1)).default([]),
          text: z.string().trim().min(1).max(20_000),
        }),
        name: 'discussion.message.post',
        run: async (context, input) => {
          await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'contributor');
          const messageId = newId('message');
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
    ];
  }

  #queryDefinitions() {
    return [
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
        description: 'Describe the active Fields in a Table Channel.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.describe',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const fields = await this.store.listTableFields(input.channelId);
          return {
            data: fields.map((field) => ({
              id: field.id,
              key: field.key,
              label: field.label,
              required: field.required,
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
        description: 'List current Records in a Table Channel.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.records.list',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId, 'table');
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const records = await this.store.listTableRecords(input.channelId);
          return {
            data: records.map((record) => ({ id: record.id, values: record.values })),
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
        description: 'List Messages in one Channel Discussion.',
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'discussion.messages.list',
        run: async (context, input): Promise<QueryResult> => {
          const channel = await this.#requireChannel(input.channelId);
          await this.#requireRole(context.actorId, input.channelId, 'viewer');
          const messages = await this.store.listMessages(input.channelId);
          return {
            data: messages.map((message) => ({
              authorId: message.authorId,
              createdAt: message.createdAt,
              id: message.id,
              recordReferences: [...message.recordReferences],
              text: message.text,
            })),
            view: {
              bindings: { messages: '$result' },
              commands: ['discussion.message.post'],
              kind: 'discussion',
              schemaVersion: 'datagram/view@1',
              title: `${channel.title} Discussion`,
            },
          };
        },
      }),
    ];
  }

  #validateFieldValue(type: TableField['type'], rawValue: unknown): JsonValue {
    const value = toJson(rawValue);
    switch (type) {
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
          typeof value === 'string' && !Number.isNaN(Date.parse(value)),
          'table.field-type',
          'Expected ISO date-time value',
        );
        return value;
      case 'dictionary':
      case 'record-reference':
        invariant(
          typeof value === 'string',
          'table.field-type',
          `Expected stable identity for ${type} value`,
        );
        return value;
      default:
        throw new DatagramError('table.field-type', `Unsupported Field type: ${String(type)}`);
    }
  }
}
