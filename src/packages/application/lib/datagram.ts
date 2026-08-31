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

  executeAction(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<ActionReceipt> {
    return this.actions.execute(name, { actorId, origin }, input);
  }

  executeQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<QueryResult> {
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
          await this.#requireChannel(input.channelId);
          await this.#requirePerson(input.personId);
          await this.#requireRole(context.actorId, input.channelId, 'admin');
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
        inputSchema: z.object({}),
        name: 'channel.list',
        run: async (context): Promise<QueryResult> => {
          await this.#requirePerson(context.actorId);
          const channels = await this.store.listChannels(context.actorId);
          return {
            data: channels.map((channel) => ({
              id: channel.id,
              title: channel.title,
              typeId: channel.typeId,
              typeVersion: channel.typeVersion,
              updatedAt: channel.updatedAt,
            })),
            view: {
              bindings: { items: '$result' },
              commands: ['channel.create'],
              kind: 'table',
              schemaVersion: 'datagram/view@1',
              title: 'Channels',
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
