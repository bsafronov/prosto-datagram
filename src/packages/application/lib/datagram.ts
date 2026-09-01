import * as z from 'zod/v4';

import {
  ChannelTypeRegistry,
  dictionaryLabelKey,
  normalizeDictionaryLabel,
  validateTableFieldValue,
} from '../../domain/channel-types';
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
import type { ChannelActionCapabilities, ChannelTypeStatePort } from '../../domain/lib/channel-type-modules/contract';
import { ActionRegistry, QueryRegistry, defineAction, defineQuery } from './contracts';
import type {
  ChannelTypeContractSelector,
  ExecutionContext,
} from './contracts';
import { ResultHandleBroker, transformResult } from './result-handles';
import { applyTableRecordUpdate } from './domain-transitions';
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

const toJson = (value: unknown): JsonValue => jsonValueSchema.parse(value);

const immutableInput = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutableInput(child);
  return Object.freeze(value);
};

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
    const actions = this.#actionDefinitions();
    const queries = this.#queryDefinitions();
    const channelActionNames = new Set(
      this.channelTypes.list().flatMap((definition) =>
        definition.actions.map((contract) => contract.name),
      ),
    );
    const channelQueryNames = new Set(
      this.channelTypes.list().flatMap((definition) =>
        definition.queries.map((contract) => contract.name),
      ),
    );
    const unambiguousContracts = (kind: 'actions' | 'queries') => {
      const installed = this.channelTypes.list();
      const versionsByType = new Map<string, number>();
      for (const definition of installed) {
        versionsByType.set(definition.id, (versionsByType.get(definition.id) ?? 0) + 1);
      }
      const candidates = [...installed]
        .sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`))
        .flatMap((definition) => definition[kind].map((contract) => ({
          contract,
          owner: `${definition.id}@${definition.version}`,
        })));
      const grouped = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        grouped.set(candidate.contract.name, [...(grouped.get(candidate.contract.name) ?? []), candidate]);
      }
      return [...grouped.values()].flatMap((overloads) => {
        const owners = new Set(overloads.map((candidate) => candidate.owner));
        const schemas = new Set(overloads.map((candidate) => JSON.stringify(z.toJSONSchema(candidate.contract.inputSchema))));
        const implementations = new Set(overloads.map((candidate) => candidate.contract.execute));
        const typeId = overloads[0]!.owner.split('@', 1)[0]!;
        const sharedContract = overloads.length > 1 && implementations.size === 1;
        const inputJson = z.toJSONSchema(overloads[0]!.contract.inputSchema) as { required?: string[] };
        const dispatchableWithoutSelector = inputJson.required?.includes('channelId') ||
          overloads[0]!.contract.name === 'channel.create' || overloads[0]!.contract.name === 'chart.create';
        return dispatchableWithoutSelector && schemas.size === 1 && implementations.size === 1 &&
          (sharedContract || (owners.size === 1 && versionsByType.get(typeId) === 1))
          ? [overloads[0]!.contract]
          : [];
      });
    };
    this.actions = new ActionRegistry(
      actions.filter((definition) => !channelActionNames.has(definition.name)),
      (selector, name) =>
        this.channelTypes.requireAction(selector.typeId, selector.typeVersion, name),
      channelActionNames,
      (selector) => selector
        ? this.channelTypes.require(selector.typeId, selector.typeVersion).actions
        : unambiguousContracts('actions'),
    );
    this.queries = new QueryRegistry(
      queries.filter((definition) => !channelQueryNames.has(definition.name)),
      (selector, name) =>
        this.channelTypes.requireQuery(selector.typeId, selector.typeVersion, name),
      channelQueryNames,
      (selector) => selector
        ? this.channelTypes.require(selector.typeId, selector.typeVersion).queries
        : unambiguousContracts('queries'),
    );
  }

  async verifyServiceIdentity(actorId: string): Promise<{ readonly actorId: string }> {
    await this.#requirePerson(actorId);
    return { actorId };
  }

  async executeAction(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
    selectedType?: ChannelTypeContractSelector,
  ): Promise<ActionReceipt> {
    const actor = await this.#requirePerson(actorId);
    const selectedInput = this.#applySelectedCreationType(name, input, selectedType);
    if (
      name === 'channel.create' &&
      selectedInput !== null &&
      typeof selectedInput === 'object' &&
      !Array.isArray(selectedInput) &&
      (selectedInput as Record<string, unknown>).typeId === 'chart'
    ) {
      throw new DatagramError(
        'chart.definition-required',
        'Create Chart Channels through chart.create',
      );
    }
    const contract = await this.#channelContract('action', name, selectedInput, selectedType);
    if (selectedType && contract) {
      invariant(
        contract.typeId === selectedType.typeId &&
          contract.typeVersion === selectedType.typeVersion,
        'channel-type.version-mismatch',
        'Selected Channel Type version does not own this Channel',
        409,
      );
    }
    if (contract) {
      const parsedInput = immutableInput(contract.schema.parse(selectedInput));
      const authorization = this.channelTypes.requireAuthorization(
        contract.typeId,
        contract.typeVersion,
        'action',
        name,
      );
      invariant(authorization, 'channel-type.action-undeclared', 'Channel Type Action is not declared');
      let selectedChannelId =
        selectedInput && typeof selectedInput === 'object' && !Array.isArray(selectedInput) &&
        typeof (selectedInput as Record<string, unknown>).channelId === 'string'
          ? (selectedInput as Record<string, unknown>).channelId as string
          : undefined;
      if (authorization.kind === 'channel-role') {
        invariant(
          selectedChannelId,
          'channel-type.capability-denied',
          'Channel Type Action requires a selected Channel',
          403,
        );
        await this.#requireRole(actorId, selectedChannelId, authorization.minimumRole);
      } else if (authorization.kind === 'message-author-or-admin') {
        invariant(
          selectedChannelId && selectedInput && typeof selectedInput === 'object' &&
          typeof (selectedInput as Record<string, unknown>).messageId === 'string',
          'channel-type.capability-denied',
          'Message authorization requires one selected Message',
          403,
        );
        await this.#requireMessageAuthorOrAdmin(
          actorId,
          await this.#requireMessage(
            selectedChannelId,
            (selectedInput as Record<string, unknown>).messageId as string,
          ),
        );
      } else if (authorization.kind === 'operator') {
        invariant(
          actor.isOperator,
          'permission.denied',
          'Deployment Operator authority is required',
          403,
        );
      }
      const pendingChanges: DomainChange[] = [];
      let pendingSubject: ActionReceipt['subject'];
      let pendingActivityKind: string | undefined;
      const allowedBuilderNames = new Set(
        this.channelTypes.requireAllowedOperations(contract.typeId, contract.typeVersion, name),
      );
      const requireSelectedChannel = async (): Promise<Channel> => {
        invariant(selectedChannelId, 'channel-type.capability-denied', 'Mutation requires one selected Channel', 403);
        const channel = await this.#requireChannel(selectedChannelId);
        invariant(
          channel.typeId === contract.typeId && channel.typeVersion === contract.typeVersion,
          'channel-type.version-mismatch',
          'Selected Channel Type version does not own this Channel',
          409,
        );
        return channel;
      };
      const requireOwned = async <T extends { readonly channelId: string }>(
        value: T | null,
        code: string,
      ): Promise<T> => {
        await requireSelectedChannel();
        invariant(value?.channelId === selectedChannelId, code, 'Target does not belong to the selected Channel', 404);
        return value!;
      };
      type RecordUpdateIntent = Parameters<NonNullable<ChannelActionCapabilities['changes']['updateTableRecord']>>[0];
      const queueTableRecordUpdate = async (recordInput: RecordUpdateIntent): Promise<void> => {
        invariant(contract.typeId === 'table' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Table transitions', 403);
        const storedRecord = await requireOwned(await this.store.getTableRecord(recordInput.recordId), 'table.record-not-found');
        const storedRecords = await this.store.listTableRecords(selectedChannelId);
        const records = pendingChanges.reduce<TableRecord[]>((current, change) =>
          change.kind === 'table.record-updated'
            ? current.map((record) => record.id === change.recordId ? applyTableRecordUpdate(record, change) : record)
            : current,
        [...storedRecords]);
        const record = records.find((candidate) => candidate.id === storedRecord.id)!;
        invariant(
          record.tombstonedAt === undefined || name === 'table.field.add' || name === 'table.field.convert',
          'table.record-tombstoned',
          'Table Record is tombstoned',
          409,
        );
        const changedKeys = Object.keys(recordInput.values);
        invariant(changedKeys.length > 0, 'table.record-empty-edit', 'Table Record edit needs at least one Field');
        invariant(changedKeys.every((key) => recordInput.observedVersions[key] !== undefined), 'table.record-observed-version-required', 'Observed version is required for every edited Field');
        for (const key of changedKeys) invariant((record.fieldVersions[key] ?? 0) === recordInput.observedVersions[key], 'table.record-edit-conflict', `Table Field value changed after observation: ${key}`, 409);
        const storedFields = await this.store.listTableFields(selectedChannelId);
        const fields = pendingChanges.reduce<TableField[]>((current, change) => {
          if (change.kind === 'table.field-added') return [...current, change.field];
          if (change.kind === 'table.field-updated') return current.map((field) => field.id === change.field.id ? change.field : field);
          if (change.kind === 'table.field-purged') return current.filter((field) => field.id !== change.fieldId);
          return current;
        }, [...storedFields]);
        const activeFieldKeys = new Set(fields.filter((field) => field.tombstonedAt === undefined).map((field) => field.key));
        invariant(changedKeys.every((key) => activeFieldKeys.has(key)), 'table.record-unknown-field', 'Table Record patches may target active Fields only');
        const validatedValues = await this.#validatedRecordValues(
          actorId,
          fields,
          records,
          { ...record.values, ...recordInput.values },
          record.id,
          true,
          new Set(changedKeys),
        );
        pendingChanges.push({
          expectedVersions: Object.fromEntries(changedKeys.map((key) => [key, recordInput.observedVersions[key]!])),
          kind: 'table.record-updated',
          previousValues: changedKeys.map((key) => ({ existed: Object.hasOwn(record.values, key), key, ...(Object.hasOwn(record.values, key) ? { value: record.values[key] } : {}) })),
          recordId: record.id,
          updatedAt: nowIso(),
          values: Object.fromEntries(changedKeys.map((key) => [key, validatedValues[key]!])),
        });
        pendingSubject = { id: recordInput.recordId, kind: 'record' };
      };
      return this.channelTypes.executeAction(
        contract.typeId,
        contract.typeVersion,
        name,
        selectedInput,
        {
          actorId,
          changes: Object.fromEntries(Object.entries({
            createChannel: (title) => {
              invariant(
                authorization.kind !== 'channel-role' && selectedChannelId === undefined,
                'channel-type.capability-denied',
                'Only a Channel creation contract may create its Channel',
                403,
              );
              selectedChannelId = newId('channel');
              const createdAt = nowIso();
              const channel: Channel = {
                createdAt,
                id: selectedChannelId,
                ownerId: actorId,
                title,
                typeId: contract.typeId,
                typeVersion: contract.typeVersion,
                updatedAt: createdAt,
              };
              pendingChanges.push(
                { channel, kind: 'channel.created' },
                {
                  kind: 'membership.granted',
                  membership: { channelId: selectedChannelId, personId: actorId, role: 'owner' },
                },
              );
              pendingSubject = { id: selectedChannelId, kind: 'channel' };
              return selectedChannelId;
            },
            createChart: async () => {
              invariant(contract.typeId === 'chart' && selectedChannelId === undefined, 'channel-type.capability-denied', 'Only Chart creation may consume a Chart Handle', 403);
              const chartInput = parsedInput as {
                handleId: string;
                presentation: ChartDefinition['presentation'];
                title: string;
              };
              const durable = await this.handles.consumeDefinition(this.handles.serviceId, actorId, chartInput.handleId, 'chart.create');
              selectedChannelId = newId('channel');
              const definition = await this.#chartDefinitionFromResult(actorId, selectedChannelId, durable, chartInput.presentation, 1);
              const occurredAt = nowIso();
              pendingChanges.push(
                { channel: { createdAt: occurredAt, id: selectedChannelId, ownerId: actorId, title: chartInput.title, typeId: contract.typeId, typeVersion: contract.typeVersion, updatedAt: occurredAt }, kind: 'channel.created' },
                { kind: 'membership.granted', membership: { channelId: selectedChannelId, personId: actorId, role: 'owner' } },
                { definition, kind: 'chart.definition-set' },
              );
              pendingSubject = { id: selectedChannelId, kind: 'channel' };
            },
            setChartDefinition: async (definition, expectedVersion) => {
              invariant(contract.typeId === 'chart' && selectedChannelId === definition.channelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Chart transitions', 403);
              await requireSelectedChannel();
              const current = await this.store.getChartDefinition(definition.channelId);
              invariant(current?.channelId === selectedChannelId, 'chart.definition-not-found', 'Chart definition does not belong to the selected Channel', 404);
              pendingChanges.push({ definition, kind: 'chart.definition-set', ...(expectedVersion === undefined ? {} : { expectedVersion }) });
              pendingSubject = { id: definition.channelId, kind: 'channel' };
            },
            recordChartEvent: async (kind) => {
              invariant(contract.typeId === 'chart' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Chart events', 403);
              await requireSelectedChannel();
              pendingActivityKind = kind;
              pendingSubject = { id: selectedChannelId, kind: 'channel' };
            },
            createDictionaryEntry: async (label) => {
              invariant(
                contract.typeId === 'dictionary' && selectedChannelId,
                'channel-type.capability-denied',
                'This Channel Type cannot emit Dictionary transitions',
                403,
              );
              await requireSelectedChannel();
              const normalizedLabel = dictionaryLabelKey(label);
              invariant(
                !(await this.store.listDictionaryEntries(selectedChannelId)).some(
                  (entry) => entry.retiredAt === undefined && entry.normalizedLabel === normalizedLabel,
                ),
                'dictionary.entry-label-conflict',
                'Active Dictionary Entry labels must be unique',
                409,
              );
              const entryId = newId('entry');
              pendingChanges.push({
                entry: {
                  channelId: selectedChannelId,
                  createdAt: nowIso(),
                  createdBy: actorId,
                  id: entryId,
                  label: normalizeDictionaryLabel(label),
                  normalizedLabel,
                },
                kind: 'dictionary.entry-created',
              });
              pendingSubject = { id: entryId, kind: 'dictionary-entry' };
              return entryId;
            },
            renameDictionaryEntry: async (change) => {
              invariant(contract.typeId === 'dictionary' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Dictionary transitions', 403);
              await requireOwned(await this.store.getDictionaryEntry(change.entryId), 'dictionary.entry-not-found');
              pendingChanges.push({ kind: 'dictionary.entry-renamed', ...change });
              pendingSubject = { id: change.entryId, kind: 'dictionary-entry' };
            },
            restoreDictionaryEntry: async (entryId, restoredAt) => {
              invariant(contract.typeId === 'dictionary' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Dictionary transitions', 403);
              await requireOwned(await this.store.getDictionaryEntry(entryId), 'dictionary.entry-not-found');
              pendingChanges.push({ entryId, kind: 'dictionary.entry-restored', restoredAt });
              pendingSubject = { id: entryId, kind: 'dictionary-entry' };
            },
            retireDictionaryEntry: async (entryId, retiredAt) => {
              invariant(contract.typeId === 'dictionary' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Dictionary transitions', 403);
              await requireOwned(await this.store.getDictionaryEntry(entryId), 'dictionary.entry-not-found');
              pendingChanges.push({ actorId, entryId, kind: 'dictionary.entry-retired', retiredAt });
              pendingSubject = { id: entryId, kind: 'dictionary-entry' };
            },
            editDiscussionMessage: async (messageId, text) => {
              invariant(selectedChannelId, 'channel-type.capability-denied', 'Discussion transition requires a Channel', 403);
              const message = await requireOwned(await this.store.getMessage(messageId), 'discussion.message-not-found');
              await this.#requireMessageAuthorOrAdmin(actorId, message);
              invariant(message.tombstonedAt === undefined, 'discussion.message-tombstoned', 'Tombstoned Message cannot be edited', 409);
              pendingChanges.push({
                kind: 'discussion.message-edited',
                messageId,
                revision: { createdAt: nowIso(), editorId: actorId, id: newId('revision'), text },
              });
              pendingSubject = { id: messageId, kind: 'message' };
            },
            postDiscussionMessage: async (messageInput) => {
              invariant(selectedChannelId, 'channel-type.capability-denied', 'Discussion transition requires a Channel', 403);
              await requireSelectedChannel();
              if (messageInput.replyToMessageId) {
                await requireOwned(await this.store.getMessage(messageInput.replyToMessageId), 'discussion.message-not-found');
              }
              const messageId = newId('message');
              const createdAt = nowIso();
              pendingChanges.push({
                kind: 'discussion.message-posted',
                message: {
                  authorId: actorId,
                  channelId: selectedChannelId,
                  createdAt,
                  id: messageId,
                  recordReferences: messageInput.recordReferences,
                  ...(messageInput.replyToMessageId ? { replyToMessageId: messageInput.replyToMessageId } : {}),
                  revisions: [{ createdAt, editorId: actorId, id: newId('revision'), text: messageInput.text }],
                  text: messageInput.text,
                },
              });
              pendingSubject = { id: messageId, kind: 'message' };
              return messageId;
            },
            restoreDiscussionMessage: async (messageId) => {
              const message = await requireOwned(await this.store.getMessage(messageId), 'discussion.message-not-found');
              await this.#requireMessageAuthorOrAdmin(actorId, message);
              invariant(message.tombstonedAt !== undefined, 'discussion.message-not-tombstoned', 'Message is not tombstoned', 409);
              pendingChanges.push({ kind: 'discussion.message-restored', messageId, restoredBy: actorId });
              pendingSubject = { id: messageId, kind: 'message' };
            },
            tombstoneDiscussionMessage: async (messageId) => {
              const message = await requireOwned(await this.store.getMessage(messageId), 'discussion.message-not-found');
              await this.#requireMessageAuthorOrAdmin(actorId, message);
              invariant(message.tombstonedAt === undefined, 'discussion.message-already-tombstoned', 'Message is already tombstoned', 409);
              pendingChanges.push({ actorId, kind: 'discussion.message-tombstoned', messageId, tombstonedAt: nowIso() });
              pendingSubject = { id: messageId, kind: 'message' };
            },
            createTableRecord: async (values) => {
              invariant(
                contract.typeId === 'table' && selectedChannelId,
                'channel-type.capability-denied',
                'This Channel Type cannot emit Table Record transitions',
                403,
              );
              await requireSelectedChannel();
              const fields = await this.store.listTableFields(selectedChannelId);
              const validatedValues = await this.#validatedRecordValues(
                actorId,
                fields,
                await this.store.listTableRecords(selectedChannelId),
                values,
                undefined,
                true,
              );
              const recordId = newId('record');
              pendingChanges.push({
                kind: 'table.record-created',
                record: {
                  channelId: selectedChannelId,
                  createdAt: nowIso(),
                  createdBy: actorId,
                  fieldVersions: Object.fromEntries(
                    fields
                      .filter((field) => field.tombstonedAt === undefined && field.key in validatedValues)
                      .map((field) => [field.key, field.version]),
                  ),
                  id: recordId,
                  values: validatedValues,
                },
              });
              pendingSubject = { id: recordId, kind: 'record' };
              return recordId;
            },
            createTableView: async (viewInput) => {
              invariant(
                contract.typeId === 'table' && selectedChannelId,
                'channel-type.capability-denied',
                'This Channel Type cannot emit Table View transitions',
                403,
              );
              await requireSelectedChannel();
              if (viewInput.visibility === 'shared') {
                await this.#requireRole(actorId, selectedChannelId, 'admin');
              }
              const fields = await this.store.listTableFields(selectedChannelId);
              const knownIds = new Set(fields.map((field) => field.id));
              const referencedIds = [
                ...viewInput.visibleFieldIds,
                ...viewInput.filters.map((filter) => filter.fieldId),
                ...viewInput.sorting.map((sort) => sort.fieldId),
                ...viewInput.grouping,
              ];
              invariant(
                referencedIds.every((fieldId) => knownIds.has(fieldId)),
                'table.view-unknown-field',
                'Table View references an unknown Field',
              );
              invariant(
                new Set(viewInput.visibleFieldIds).size === viewInput.visibleFieldIds.length,
                'table.view-duplicate-field',
                'Visible Fields must be unique',
              );
              const viewId = newId('view');
              pendingChanges.push({
                kind: 'table.view-saved',
                view: {
                  ...viewInput,
                  channelId: selectedChannelId,
                  createdAt: nowIso(),
                  id: viewId,
                  ownerId: actorId,
                },
              });
              return viewId;
            },
            setTableDisplayField: async (displayFieldId) => {
              invariant(
                contract.typeId === 'table',
                'channel-type.capability-denied',
                'This Channel Type cannot emit Table transitions',
                403,
              );
              await requireSelectedChannel();
              if (displayFieldId !== null) {
                const field = (await this.store.listTableFields(selectedChannelId!))
                  .find((candidate) => candidate.id === displayFieldId);
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
              pendingChanges.push({
                channelId: selectedChannelId!,
                ...(displayFieldId === null ? {} : { displayFieldId }),
                kind: 'table.display-field-set',
              });
            },
            addTableField: async (field) => {
              invariant(contract.typeId === 'table' && selectedChannelId === field.channelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Table transitions', 403);
              await requireSelectedChannel();
              invariant(!(await this.store.listTableFields(selectedChannelId)).some((candidate) => candidate.id === field.id), 'table.field-conflict', 'Table Field identity already exists', 409);
              pendingChanges.push({ field, kind: 'table.field-added' });
              pendingSubject = { id: field.id, kind: 'field' };
            },
            purgeTableField: async (fieldId) => {
              invariant(contract.typeId === 'table' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Table transitions', 403);
              const stored = (await requireSelectedChannel(), (await this.store.listTableFields(selectedChannelId)).find((candidate) => candidate.id === fieldId));
              invariant(stored?.channelId === selectedChannelId, 'table.field-not-found', 'Table Field does not belong to the selected Channel', 404);
              invariant(stored.tombstonedAt !== undefined, 'table.field-not-tombstoned', 'Table Field must be tombstoned before purge', 409);
              pendingChanges.push({ channelId: selectedChannelId, expectedVersion: stored.version, fieldId: stored.id, fieldKey: stored.key, kind: 'table.field-purged' });
              pendingSubject = { id: stored.id, kind: 'field' };
            },
            updateTableField: async (intent) => {
              invariant(contract.typeId === 'table' && selectedChannelId, 'channel-type.capability-denied', 'This Channel Type cannot emit Table transitions', 403);
              await requireSelectedChannel();
              const stored = (await this.store.listTableFields(selectedChannelId)).find((candidate) => candidate.id === intent.fieldId);
              invariant(stored?.channelId === selectedChannelId, 'table.field-not-found', 'Table Field does not belong to the selected Channel', 404);
              invariant(stored.version === intent.observedVersion, 'table.field-conflict', 'Table Field changed after observation', 409);
              let field: TableField;
              if (intent.kind === 'tombstone') {
                invariant(stored.tombstonedAt === undefined, 'table.field-already-tombstoned', 'Table Field is already tombstoned', 409);
                field = { ...stored, tombstonedAt: nowIso(), tombstonedBy: actorId, version: stored.version + 1 };
              } else if (intent.kind === 'restore') {
                invariant(stored.tombstonedAt !== undefined, 'table.field-not-tombstoned', 'Table Field is not tombstoned', 409);
                const { tombstonedAt: _at, tombstonedBy: _by, ...active } = stored;
                field = { ...active, version: stored.version + 1 };
                const fields = (await this.store.listTableFields(selectedChannelId)).map((candidate) => candidate.id === stored.id ? field : candidate);
                const records = await this.store.listTableRecords(selectedChannelId);
                for (const record of records.filter((candidate) => candidate.tombstonedAt === undefined)) {
                  await this.#validatedRecordValues(actorId, fields, records, record.values, record.id, true, new Set());
                }
              } else {
                invariant(stored.tombstonedAt === undefined, 'table.field-tombstoned', 'Table Field is tombstoned', 409);
                invariant(stored.type !== intent.targetType, 'table.field-type-unchanged', 'Target Field type must differ', 409);
                const isDictionary = intent.targetType === 'dictionary';
                const isReference = intent.targetType === 'record-reference';
                invariant(isReference ? intent.targetChannelId !== undefined && intent.cardinality !== undefined : intent.cardinality === undefined, 'table.field-reference-configuration', 'Record Reference Field requires one target Channel and cardinality');
                invariant(isDictionary ? intent.targetChannelId !== undefined : isReference || intent.targetChannelId === undefined, 'table.field-dictionary-configuration', 'Dictionary Field requires one target Dictionary Channel');
                const { cardinality: _oldCardinality, defaultValue: _oldDefault, targetChannelId: _oldTarget, ...base } = stored;
                field = {
                  ...base,
                  ...(intent.cardinality === undefined ? {} : { cardinality: intent.cardinality }),
                  ...(intent.targetChannelId === undefined ? {} : { targetChannelId: intent.targetChannelId }),
                  type: intent.targetType,
                  version: stored.version + 1,
                };
                await this.#channelTypeState(actorId, selectedChannelId, { typeId: contract.typeId, typeVersion: contract.typeVersion })
                  .then((state) => state.validateTableFieldTarget(field));
                const resolveValue = async (resolution: { readonly kind: 'correct' | 'map' | 'null'; readonly value?: JsonValue }): Promise<JsonValue> => {
                  if (resolution.kind === 'null') {
                    invariant(!stored.required, 'table.field-conversion-null-required', 'Required Field cannot be explicitly nulled');
                    invariant(resolution.value === undefined, 'table.field-conversion-resolution-invalid', 'Null resolution cannot include a value');
                    return null;
                  }
                  invariant(resolution.value !== undefined && resolution.value !== null, 'table.field-conversion-resolution-required', 'Correction or mapping needs a replacement value');
                  invariant(await this.#fieldAccepts(actorId, field, resolution.value), 'table.field-conversion-resolution-invalid', 'Replacement value is incompatible with target Field');
                  return resolution.value;
                };
                const defaultFails = stored.defaultValue !== undefined && stored.defaultValue !== null &&
                  !(await this.#fieldAccepts(actorId, field, stored.defaultValue));
                invariant(
                  defaultFails === (intent.defaultResolution !== undefined),
                  'table.field-conversion-default-unresolved',
                  defaultFails ? 'Incompatible default value needs one explicit resolution' : 'Default resolution does not match an incompatible default',
                  409,
                );
                const nextDefault = intent.defaultResolution
                  ? await resolveValue(intent.defaultResolution)
                  : stored.defaultValue;
                field = { ...field, ...(nextDefault === undefined ? {} : { defaultValue: nextDefault }) };
                const records = await this.store.listTableRecords(selectedChannelId);
                const failures = (await Promise.all(records.map(async (record) => {
                  const value = record.values[stored.key];
                  return value !== undefined && value !== null && !(await this.#fieldAccepts(actorId, field, value)) ? record : null;
                }))).filter((record): record is TableRecord => record !== null);
                const requestedResolutions = intent.resolutions ?? [];
                const resolutions = new Map(requestedResolutions.map((resolution) => [resolution.recordId, resolution]));
                invariant(resolutions.size === requestedResolutions.length, 'table.field-conversion-resolution-duplicate', 'Each Record may have one conversion resolution');
                invariant(failures.length === resolutions.size && failures.every((record) => resolutions.has(record.id)), 'table.field-conversion-unresolved', 'Every incompatible value needs one explicit resolution', 409);
                const updates = new Map(await Promise.all(failures.map(async (record) => [record.id, await resolveValue(resolutions.get(record.id)!)] as const)));
                const nextRecords = records.map((record) => updates.has(record.id) ? { ...record, values: { ...record.values, [stored.key]: updates.get(record.id)! } } : record);
                const fields = (await this.store.listTableFields(selectedChannelId)).map((candidate) => candidate.id === stored.id ? field : candidate);
                for (const record of nextRecords.filter((candidate) => candidate.tombstonedAt === undefined)) {
                  await this.#validatedRecordValues(actorId, fields, nextRecords, record.values, record.id, true, new Set([stored.key]));
                }
                pendingChanges.push({ expectedVersion: stored.version, field, kind: 'table.field-updated', previousField: stored });
                for (const record of failures) {
                  await queueTableRecordUpdate({ observedVersions: { [stored.key]: record.fieldVersions[stored.key] ?? 0 }, recordId: record.id, values: { [stored.key]: updates.get(record.id)! } });
                }
                pendingSubject = { id: field.id, kind: 'field' };
                return;
              }
              pendingChanges.push({ expectedVersion: stored.version, field, kind: 'table.field-updated', previousField: stored });
              pendingSubject = { id: field.id, kind: 'field' };
            },
            updateTableRecord: queueTableRecordUpdate,
            restoreTableRecord: async (recordId, expectedTombstonedAt) => {
              await requireOwned(await this.store.getTableRecord(recordId), 'table.record-not-found');
              pendingChanges.push({ kind: 'table.record-restored', recordId, restoredAt: nowIso(), ...(expectedTombstonedAt ? { expectedTombstonedAt } : {}) });
              pendingSubject = { id: recordId, kind: 'record' };
            },
            tombstoneTableRecord: async (recordId, expectedUpdatedAt) => {
              await requireOwned(await this.store.getTableRecord(recordId), 'table.record-not-found');
              pendingChanges.push({ actorId, kind: 'table.record-tombstoned', recordId, tombstonedAt: nowIso(), ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) });
              pendingSubject = { id: recordId, kind: 'record' };
            },
          } satisfies Required<ChannelActionCapabilities['changes']>).filter(([builder]) => allowedBuilderNames.has(
            builder as keyof ChannelActionCapabilities['changes'],
          ))) as ChannelActionCapabilities['changes'],
          commit: async () => {
            const requestedChannelId =
              selectedInput && typeof selectedInput === 'object' && !Array.isArray(selectedInput)
                ? (selectedInput as Record<string, unknown>).channelId
                : undefined;
            invariant(
              authorization.kind === 'authenticated' || authorization.kind === 'operator'
                ? requestedChannelId === undefined
                : requestedChannelId === selectedChannelId,
              'channel-type.capability-denied',
              'Channel Type handler may only commit to its selected Channel',
              403,
            );
            invariant(
              pendingChanges.length > 0 || pendingActivityKind !== undefined,
              'channel-type.capability-denied',
              'Channel Type handler did not build a transition',
              403,
            );
            const activityKind = pendingActivityKind ?? this.channelTypes.activityFor(
              contract.typeId,
              contract.typeVersion,
              pendingChanges,
            );
            invariant(
              activityKind && this.channelTypes
                .require(contract.typeId, contract.typeVersion)
                .activityKinds.includes(activityKind),
              'channel-type.capability-denied',
              'Channel Type handler did not build a declared transition',
              403,
            );
            const channel =
              await this.store.getChannel(selectedChannelId!) ??
              pendingChanges.find((change) => change.kind === 'channel.created')?.channel;
            invariant(
              channel?.typeId === contract.typeId && channel.typeVersion === contract.typeVersion,
              'channel-type.version-mismatch',
              'Selected Channel Type version does not own this Channel',
              409,
            );
            return this.#commit(
              { actorId, origin },
              name,
              selectedChannelId,
              (operationId, occurredAt) => [
                ...pendingChanges,
                {
                  activity: this.#activity(
                    actorId,
                    selectedChannelId!,
                    activityKind,
                    operationId,
                    occurredAt,
                  ),
                  kind: 'activity.appended',
                },
              ],
              pendingSubject,
            );
          },
          ...(allowedBuilderNames.has('cancel') ? {
            cancel: (subject: ActionReceipt['subject']) => this.#commit({ actorId, origin }, name, selectedChannelId, () => [], subject),
          } : {}),
          newId,
          now: nowIso,
          ...(selectedChannelId ? {
            state: await this.#channelTypeState(actorId, selectedChannelId, {
              typeId: contract.typeId,
              typeVersion: contract.typeVersion,
            }),
          } : {}),
        },
      );
    }
    return this.actions.execute(
      name,
      { actorId, origin },
      selectedInput,
    );
  }

  async executeQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
    selectedType?: ChannelTypeContractSelector,
    queryStack: readonly string[] = [],
  ): Promise<QueryResult> {
    await this.#requirePerson(actorId);
    const contract = await this.#channelContract('query', name, input, selectedType);
    if (selectedType && contract) {
      invariant(
        contract.typeId === selectedType.typeId &&
          contract.typeVersion === selectedType.typeVersion,
        'channel-type.version-mismatch',
        'Selected Channel Type version does not own this Channel',
        409,
      );
    }
    const contractKey = contract
      ? `${contract.typeId}@${contract.typeVersion}:${name}`
      : undefined;
    invariant(
      !contractKey || !queryStack.includes(contractKey),
      'channel-type.query-cycle',
      'Channel Type Query composition contains a cycle',
      409,
    );
    const nextQueryStack = contractKey ? [...queryStack, contractKey] : queryStack;
    const queryRole = contract
      ? this.channelTypes.requireAuthorization(
          contract.typeId,
          contract.typeVersion,
          'query',
          name,
        )
      : undefined;
    if (queryRole?.kind === 'channel-role') {
      invariant(
        typeof (input as { channelId?: unknown }).channelId === 'string',
        'channel-type.capability-denied',
        'Channel role authorization requires one selected Channel',
        403,
      );
      await this.#requireRole(
        actorId,
        (input as { channelId: string }).channelId,
        queryRole.minimumRole,
      );
    } else if (queryRole?.kind === 'message-author-or-admin') {
      await this.#requireMessageAuthorOrAdmin(
        actorId,
        await this.#requireMessage(
          (input as { channelId: string }).channelId,
          (input as { messageId: string }).messageId,
        ),
      );
    } else if (queryRole?.kind === 'operator') {
      const actor = await this.#requirePerson(actorId);
      invariant(
        actor.isOperator,
        'permission.denied',
        'Deployment Operator authority is required',
        403,
      );
    }
    const result: QueryResult = contract
      ? await this.channelTypes.executeQuery<QueryResult>(
          contract.typeId,
          contract.typeVersion,
          name,
          input,
          {
            actorId,
            read: async (query, readInput) => {
              const selectedChannelId = (input as { channelId: string }).channelId;
              invariant(
                readInput.channelId === selectedChannelId,
                'channel-type.capability-denied',
                'Channel Type Query reads must stay within its selected Channel',
                403,
              );
              invariant(
                this.channelTypes.requireQuery(contract.typeId, contract.typeVersion, query),
                'channel-type.capability-denied',
                'Channel Type Query may only read another declared Query',
                403,
              );
              const readAuthorization = this.channelTypes.requireAuthorization(
                contract.typeId,
                contract.typeVersion,
                'query',
                query,
              );
              await this.#requireRole(
                actorId,
                selectedChannelId,
                readAuthorization?.kind === 'channel-role'
                  ? readAuthorization.minimumRole
                  : 'viewer',
              );
              return this.executeQuery(
                actorId,
                origin,
                query,
                readInput,
                { typeId: contract.typeId, typeVersion: contract.typeVersion },
                nextQueryStack,
              );
            },
            ...(contract.typeId === 'chart' && typeof (input as { channelId?: unknown }).channelId === 'string' ? {
              readSourceTable: async () => {
                const definition = await this.store.getChartDefinition((input as { channelId: string }).channelId);
                invariant(definition, 'chart.definition-not-found', 'Chart definition not found', 404);
                const source = await this.#requireChannel(definition.sourceChannelId, 'table');
                return this.executeQuery(
                  actorId,
                  origin,
                  'table.records.list',
                  { channelId: source.id },
                  { typeId: source.typeId, typeVersion: source.typeVersion },
                  nextQueryStack,
                );
              },
            } : {}),
            transform: (source, definition) => transformResult(source, definition),
            ...(typeof (input as { channelId?: unknown }).channelId === 'string'
              ? {
                  role: await this.#requireRole(
                    actorId,
                    (input as { channelId: string }).channelId,
                    'viewer',
                  ),
                  state: await this.#channelTypeState(
                    actorId,
                    (input as { channelId: string }).channelId,
                    { typeId: contract.typeId, typeVersion: contract.typeVersion },
                  ),
                }
              : {}),
          },
        )
      : await this.queries.execute(name, { actorId, origin }, input);
    if (input !== null && !Array.isArray(input) && typeof input === 'object') {
      const channelId = (input as Record<string, unknown>).channelId;
      if (typeof channelId === 'string') {
        const channel = await this.store.getChannel(channelId);
        const definition = channel
          ? this.channelTypes.require(channel.typeId, channel.typeVersion)
          : undefined;
        if (definition?.queries.some((query) => query.name === name)) {
          return {
            ...result,
            view: this.channelTypes.produceView(
              channel!.typeId,
              channel!.typeVersion,
              name,
              {
                channelTitle: channel!.title,
                queryInput: input,
                resultTitle: result.view.title,
                role: await this.#requireRole(actorId, channelId, 'viewer'),
              },
            ),
          };
        }
      }
    }
    return result;
  }

  async #channelTypeState(
    actorId: string,
    channelId: string,
    selectedType: ChannelTypeContractSelector,
  ): Promise<ChannelTypeStatePort> {
    const channel = await this.#requireChannel(channelId);
    invariant(
      channel.typeId === selectedType.typeId && channel.typeVersion === selectedType.typeVersion,
      'channel-type.version-mismatch',
      'Selected Channel Type version does not own this Channel',
      409,
    );
    const scoped = <T extends { readonly channelId: string }>(value: T | null): T | null =>
      value?.channelId === channelId ? value : null;
    return {
      acceptsTableFieldValue: (field, value) => this.#fieldAccepts(actorId, field, value),
      channel,
      chartDefinition: () => this.store.getChartDefinition(channelId),
      validateChartDefinition: async (definition) => {
        invariant(definition.channelId === channelId, 'channel-type.capability-denied', 'Chart definition must belong to the selected Channel', 403);
        await this.#validateChartDefinition(actorId, definition);
      },
      dictionaryEntries: () => this.store.listDictionaryEntries(channelId),
      dictionaryEntry: async (entryId) => scoped(await this.store.getDictionaryEntry(entryId)),
      displayFieldId: () => this.store.getTableDisplayFieldId(channelId),
      message: async (messageId) => scoped(await this.store.getMessage(messageId)),
      messages: () => this.store.listMessages(channelId),
      resolveRecordReference: (recordId) => this.#resolveChannelRecordId(actorId, recordId),
      resolveTableValues: (fields, values) => this.#resolveTableValues(actorId, fields, values),
      validateTableFieldTarget: async (field) => {
        if (field.type === 'record-reference') {
          const target = await this.#requireChannel(field.targetChannelId!);
          invariant(
            this.channelTypes.require(target.typeId, target.typeVersion).recordKinds.length > 0,
            'table.record-reference-invalid',
            'Target Channel Type does not expose Channel Records',
          );
          await this.#requireRole(actorId, target.id, 'viewer');
        } else if (field.type === 'dictionary') {
          await this.#requireChannel(field.targetChannelId!, 'dictionary');
          await this.#requireRole(actorId, field.targetChannelId!, 'viewer');
        }
      },
      validateTableRecordValues: (
        fields,
        records,
        values,
        currentRecordId,
        applyDefaults,
        changedKeys,
      ) => this.#validatedRecordValues(
        actorId,
        fields,
        records,
        values,
        currentRecordId,
        applyDefaults,
        changedKeys ? new Set(changedKeys) : undefined,
      ),
      tableFields: () => this.store.listTableFields(channelId),
      tableRecord: async (recordId) => scoped(await this.store.getTableRecord(recordId)),
      tableRecords: () => this.store.listTableRecords(channelId),
      tableViews: () => this.store.listTableViews(channelId, actorId),
    };
  }

  async #channelContract(
    kind: 'action' | 'query',
    name: string,
    rawInput: unknown,
    selectedType?: ChannelTypeContractSelector,
  ): Promise<
    | { readonly schema: z.ZodType; readonly typeId: string; readonly typeVersion: string }
    | undefined
  > {
    if (rawInput === null || Array.isArray(rawInput) || typeof rawInput !== 'object') {
      return undefined;
    }
    const input = rawInput as Record<string, unknown>;
    let typeId: string | undefined;
    let typeVersion: string | undefined;
    if (typeof input.channelId === 'string') {
      const channel = await this.store.getChannel(input.channelId);
      if (channel) {
        typeId = channel.typeId;
        typeVersion = channel.typeVersion;
      }
    } else if (name === 'channel.create' && typeof input.typeId === 'string') {
      const type =
        typeof input.typeVersion === 'string'
          ? this.channelTypes.require(input.typeId, input.typeVersion)
          : selectedType
            ? this.channelTypes.require(selectedType.typeId, selectedType.typeVersion)
          : this.channelTypes.requireCurrent(input.typeId);
      typeId = type.id;
      typeVersion = type.version;
    } else if (name === 'chart.create') {
      const type =
        typeof input.typeVersion === 'string'
          ? this.channelTypes.require('chart', input.typeVersion)
          : selectedType
            ? this.channelTypes.require(selectedType.typeId, selectedType.typeVersion)
          : this.channelTypes.requireCurrent('chart');
      typeId = type.id;
      typeVersion = type.version;
    } else if (selectedType) {
      const type = this.channelTypes.require(selectedType.typeId, selectedType.typeVersion);
      typeId = type.id;
      typeVersion = type.version;
    }
    if (!typeId || !typeVersion) return undefined;
    const schema =
      kind === 'action'
        ? this.channelTypes.requireAction(typeId, typeVersion, name)
        : this.channelTypes.requireQuery(typeId, typeVersion, name);
    return schema ? { schema, typeId, typeVersion } : undefined;
  }

  #applySelectedCreationType(
    name: string,
    rawInput: unknown,
    selectedType?: ChannelTypeContractSelector,
  ): unknown {
    if (
      !selectedType ||
      (name !== 'channel.create' && name !== 'chart.create') ||
      rawInput === null ||
      Array.isArray(rawInput) ||
      typeof rawInput !== 'object'
    ) return rawInput;
    const input = rawInput as Record<string, unknown>;
    invariant(
      name !== 'channel.create' || input.typeId === selectedType.typeId,
      'channel-type.version-mismatch',
      'Selected Channel Type does not match creation input',
      409,
    );
    invariant(
      name !== 'chart.create' || selectedType.typeId === 'chart',
      'channel-type.version-mismatch',
      'Selected Channel Type does not match Chart creation',
      409,
    );
    invariant(
      input.typeVersion === undefined || input.typeVersion === selectedType.typeVersion,
      'channel-type.version-mismatch',
      'Selected Channel Type version does not match creation input',
      409,
    );
    return input.typeVersion === undefined
      ? { ...input, typeVersion: selectedType.typeVersion }
      : rawInput;
  }

  async prepareQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
    purpose = name,
    selectedType?: ChannelTypeContractSelector,
  ): Promise<IssuedResultHandle> {
    const selectedContract = await this.#channelContract('query', name, input, selectedType);
    if (selectedType && selectedContract) {
      invariant(
        selectedContract.typeId === selectedType.typeId &&
          selectedContract.typeVersion === selectedType.typeVersion,
        'channel-type.version-mismatch',
        'Selected Channel Type version does not own this Channel',
        409,
      );
    }
    const exactType = selectedContract
      ? { typeId: selectedContract.typeId, typeVersion: selectedContract.typeVersion }
      : selectedType;
    let result: QueryResult;
    try {
      result = await this.executeQuery(actorId, origin, name, input, exactType);
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
      { input: sourceInput, queryName: name, ...(exactType ? { selectedType: exactType } : {}) },
      result,
      () => this.executeQuery(actorId, origin, name, sourceInput, exactType),
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
      definition.selectedType,
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
    const channel = await this.store.getChannel(channelId);
    if (channel) this.channelTypes.require(channel.typeId, channel.typeVersion);
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
    this.channelTypes.require(channel.typeId, channel.typeVersion);
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
    this.channelTypes.require(channel.typeId, channel.typeVersion);
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
    const persistedChannel = channelId ? await this.store.getChannel(channelId) : null;
    const createdChannel = operation.changes.find((change) => change.kind === 'channel.created');
    const channel = persistedChannel ?? (createdChannel?.kind === 'channel.created' ? createdChannel.channel : null);
    if (channel) {
      const typeDefinition = this.channelTypes.require(channel.typeId, channel.typeVersion);
      if (
        operation.changes.length > 0 &&
        typeDefinition.actions.some((contract) => contract.name === action)
      ) {
        const expectedActivity = this.channelTypes.activityFor(
          channel.typeId,
          channel.typeVersion,
          operation.changes,
        );
        const activities = operation.changes.filter(
          (change) => change.kind === 'activity.appended',
        );
        invariant(
          expectedActivity !== undefined &&
            activities.length === 1 &&
            activities[0]!.kind === 'activity.appended' &&
            activities[0]!.activity.kind === expectedActivity,
          'channel-type.activity-invalid',
          'Channel Type mutation must emit its declared Activity',
        );
      }
      this.channelTypes.validateTransition(channel.typeId, channel.typeVersion, operation);
    }
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
          typeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
        }),
        name: 'channel.create',
        run: async (context, input) => {
          await this.#requirePerson(context.actorId);
          const type = input.typeVersion
            ? this.channelTypes.require(input.typeId, input.typeVersion)
            : this.channelTypes.requireCurrent(input.typeId);
          invariant(
            type.id !== 'chart',
            'chart.definition-required',
            'Create Chart Channels through chart.create',
          );
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
          for (const item of items) {
            this.channelTypes.require(item.channel.typeId, item.channel.typeVersion);
          }
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
    const sourceChannel = await this.#requireChannel(sourceInput.data.channelId, 'table');
    invariant(
      durable.sources[0]!.selectedType?.typeId === sourceChannel.typeId &&
        durable.sources[0]!.selectedType?.typeVersion === sourceChannel.typeVersion,
      'chart.result-handle-incompatible',
      'Result Handle must retain the exact source Channel Type version',
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
    const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
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
      definition.aggregations.every((aggregation) => {
        if (aggregation.operator === 'count') return true;
        return aggregation.field !== undefined &&
          fieldsByKey.get(aggregation.field)?.type === 'number';
      }),
      'chart.definition-invalid-aggregation',
      'Numeric Chart aggregations require a number Field',
    );
    invariant(
      definition.filters.every((filter) => {
        const field = fieldsByKey.get(filter.field);
        if (!field) return false;
        if (filter.operator === 'is-empty') return filter.value === undefined;
        if (filter.value === undefined) return false;
        if (filter.operator === 'contains') {
          return field.type === 'text' && typeof filter.value === 'string';
        }
        if (filter.operator === 'greater-than' || filter.operator === 'less-than') {
          return (
            (field.type === 'number' &&
              typeof filter.value === 'number' &&
              Number.isFinite(filter.value)) ||
            (field.type === 'date-time' &&
              typeof filter.value === 'string' &&
              z.iso.datetime({ offset: true }).safeParse(filter.value).success)
          );
        }
        if (filter.value === null) return true;
        switch (field.type) {
          case 'text':
            return typeof filter.value === 'string';
          case 'number':
            return typeof filter.value === 'number' && Number.isFinite(filter.value);
          case 'boolean':
            return typeof filter.value === 'boolean';
          case 'date-time':
            return typeof filter.value === 'string' &&
              z.iso.datetime({ offset: true }).safeParse(filter.value).success;
          case 'dictionary':
          case 'record-reference':
            return false;
        }
      }),
      'chart.definition-invalid-filter',
      'Chart filter operator or value is incompatible with its Field',
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
    let type;
    try {
      type = this.channelTypes.require(channel.typeId, channel.typeVersion);
    } catch (error) {
      if (error instanceof DatagramError && error.code === 'channel-type.version-unavailable') {
        return { channelId, ...(recordId ? { recordId } : {}), status: 'unresolved' };
      }
      throw error;
    }
    if (recordId !== undefined) {
      const status = await this.#channelRecordStatus(type.recordKinds, channelId, recordId);
      if (status === 'unresolved') {
        return { channelId, recordId, status: 'unresolved' };
      }
      if (status === 'deleted' || status === 'retired') return { channelId, recordId, status };
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
      await this.#validateRecordReferenceTargets(actorId, field, value, false);
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
    return validateTableFieldValue(field, rawValue);
  }

  async #validateRecordReferenceTargets(
    actorId: string,
    field: TableField,
    value: JsonValue,
    allowRetired = true,
  ): Promise<void> {
    if (field.type !== 'record-reference') return;
    invariant(
      field.targetChannelId !== undefined && field.cardinality !== undefined,
      'table.field-reference-configuration',
      'Record Reference Field is not configured',
    );
    const channel = await this.store.getChannel(field.targetChannelId);
    const membership = await this.store.getMembership(field.targetChannelId, actorId);
    let recordKinds: readonly ('dictionary-entry' | 'discussion-message' | 'table-record')[] = [];
    if (channel) {
      try {
        recordKinds = this.channelTypes.require(channel.typeId, channel.typeVersion).recordKinds;
      } catch (error) {
        if (!(error instanceof DatagramError && error.code === 'channel-type.version-unavailable')) {
          throw error;
        }
      }
    }
    invariant(
      channel !== null &&
        channel.deletedAt === undefined &&
        channel.purgedAt === undefined &&
        membership !== null &&
        recordKinds.length > 0,
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
      const status = await this.#channelRecordStatus(
        recordKinds,
        field.targetChannelId,
        recordId,
      );
      invariant(
        status === 'resolved' || (allowRetired && status === 'retired'),
        'table.record-reference-invalid',
        'Record Reference target is unavailable',
      );
    }
  }

  async #channelRecordStatus(
    recordKinds: readonly ('dictionary-entry' | 'discussion-message' | 'table-record')[],
    channelId: string,
    recordId: string,
  ): Promise<'deleted' | 'resolved' | 'retired' | 'unresolved'> {
    if (recordKinds.includes('table-record')) {
      const record = await this.store.getTableRecord(recordId);
      if (record?.channelId === channelId) {
        return record.tombstonedAt === undefined ? 'resolved' : 'deleted';
      }
    }
    if (recordKinds.includes('dictionary-entry')) {
      const entry = await this.store.getDictionaryEntry(recordId);
      if (entry?.channelId === channelId) {
        return entry.retiredAt === undefined ? 'resolved' : 'retired';
      }
    }
    if (recordKinds.includes('discussion-message')) {
      const message = await this.store.getMessage(recordId);
      if (message?.channelId === channelId) {
        return message.tombstonedAt === undefined ? 'resolved' : 'deleted';
      }
    }
    return 'unresolved';
  }

  async #resolveChannelRecordId(actorId: string, recordId: string): Promise<JsonValue> {
    const tableRecord = await this.store.getTableRecord(recordId);
    if (tableRecord) {
      if (!(await this.store.getMembership(tableRecord.channelId, actorId))) {
        return { recordId, status: 'unresolved' };
      }
      return this.#resolveReference(actorId, tableRecord.channelId, recordId);
    }
    const dictionaryEntry = await this.store.getDictionaryEntry(recordId);
    if (dictionaryEntry) {
      if (!(await this.store.getMembership(dictionaryEntry.channelId, actorId))) {
        return { recordId, status: 'unresolved' };
      }
      return this.#resolveReference(actorId, dictionaryEntry.channelId, recordId);
    }
    const message = await this.store.getMessage(recordId);
    if (message) {
      if (!(await this.store.getMembership(message.channelId, actorId))) {
        return { recordId, status: 'unresolved' };
      }
      return this.#resolveReference(actorId, message.channelId, recordId);
    }
    return { recordId, status: 'unresolved' };
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
