import * as z from 'zod/v4';

import type { ChannelTypeDefinition } from '../channel-types';
import {
  jsonValueSchema,
  recordReferenceCardinalitySchema,
  tableFieldTypeSchema,
  type JsonValue,
  type QueryResult,
  type TableField,
  type TableRecord,
} from '../model';
import { DatagramError, invariant } from '../errors';
import {
  channelCreateContract,
  channelIdSchema,
  contract,
  produceOwnedView,
  stateRule,
  type ChannelTypeStatePort,
} from './contract';
import {
  discussionActions,
  discussionActivityKinds,
  discussionActivityFor,
  discussionQueries,
  discussionView,
} from './discussion';

const optionalJsonValueSchema = jsonValueSchema.optional();
const tableViewFilterSchema = z.object({
  fieldId: z.string().min(1),
  operator: z.enum(['contains', 'equals', 'greater-than', 'is-empty', 'less-than']),
  value: optionalJsonValueSchema,
});
const tableViewSortSchema = z.object({
  direction: z.enum(['ascending', 'descending']),
  fieldId: z.string().min(1),
});
const conversionResolutionSchema = z.object({
  kind: z.enum(['correct', 'map', 'null']),
  recordId: z.string().min(1),
  value: optionalJsonValueSchema,
});
const defaultConversionResolutionSchema = z.object({
  kind: z.enum(['correct', 'map', 'null']),
  value: optionalJsonValueSchema,
});

const pendingView = (title = 'Channel Type View') => ({ bindings: {}, commands: [], kind: 'pending', schemaVersion: 'datagram/view@1' as const, title });

type ConversionResolution = {
  readonly kind: 'correct' | 'map' | 'null';
  readonly recordId?: string;
  readonly value?: JsonValue;
};

export interface TableFieldConversionInput {
  readonly cardinality?: 'many' | 'one';
  readonly defaultResolution?: Omit<ConversionResolution, 'recordId'>;
  readonly fieldId: string;
  readonly observedVersion: number;
  readonly resolutions?: readonly ConversionResolution[];
  readonly targetChannelId?: string;
  readonly targetType: TableField['type'];
}

export interface TrustedTableFieldConversionPlan {
  readonly binding: {
    readonly actorId: string;
    readonly channelId: string;
    readonly fieldId: string;
    readonly observedVersion: number;
    readonly serviceId: string;
  };
  readonly field: TableField;
  readonly previousField: TableField;
  readonly purpose: 'execute' | 'preview';
  readonly preview: {
    readonly defaultFailure: JsonValue | null;
    readonly failures: readonly { readonly originalValue: JsonValue; readonly recordId: string }[];
    readonly fieldId: string;
    readonly observedVersion: number;
    readonly targetType: TableField['type'];
  };
  readonly recordUpdates: readonly {
    readonly observedVersion: number;
    readonly previousValue?: JsonValue;
    readonly recordId: string;
    readonly value: JsonValue;
  }[];
}

export type TableFieldConversionPlanPayload = Omit<TrustedTableFieldConversionPlan, 'binding'>;
export type SealTableFieldConversionPlan = (
  payload: TableFieldConversionPlanPayload,
  fieldId: string,
  observedVersion: number,
) => TrustedTableFieldConversionPlan;

export async function planTableFieldConversion(
  input: TableFieldConversionInput,
  state: ChannelTypeStatePort,
  sealCanonicalPlan: SealTableFieldConversionPlan,
): Promise<TrustedTableFieldConversionPlan> {
  const field = (await state.tableFields()).find((candidate) => candidate.id === input.fieldId);
  invariant(field, 'table.field-not-found', 'Table Field not found', 404);
  invariant(field.channelId === state.channel.id, 'table.field-not-found', 'Table Field does not belong to the selected Channel', 404);
  invariant(field.tombstonedAt === undefined, 'table.field-tombstoned', 'Table Field is tombstoned', 409);
  invariant(field.version === input.observedVersion, 'table.field-conflict', 'Table Field changed after observation', 409);
  invariant(field.type !== input.targetType, 'table.field-type-unchanged', 'Target Field type must differ', 409);
  const isDictionary = input.targetType === 'dictionary';
  const isReference = input.targetType === 'record-reference';
  invariant(isReference ? input.targetChannelId !== undefined && input.cardinality !== undefined : input.cardinality === undefined, 'table.field-reference-configuration', 'Record Reference Field requires one target Channel and cardinality');
  invariant(isDictionary ? input.targetChannelId !== undefined : isReference || input.targetChannelId === undefined, 'table.field-dictionary-configuration', 'Dictionary Field requires one target Dictionary Channel');
  const { cardinality: _oldCardinality, defaultValue: _oldDefault, targetChannelId: _oldTarget, ...base } = field;
  let nextField: TableField = {
    ...base,
    ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
    ...(input.targetChannelId === undefined ? {} : { targetChannelId: input.targetChannelId }),
    type: input.targetType,
    version: field.version + 1,
  };
  await state.validateTableFieldTarget(nextField);
  const resolveValue = async (resolution: ConversionResolution): Promise<JsonValue> => {
    if (resolution.kind === 'null') {
      invariant(!field.required, 'table.field-conversion-null-required', 'Required Field cannot be explicitly nulled');
      invariant(resolution.value === undefined, 'table.field-conversion-resolution-invalid', 'Null resolution cannot include a value');
      return null;
    }
    invariant(resolution.value !== undefined && resolution.value !== null, 'table.field-conversion-resolution-required', 'Correction or mapping needs a replacement value');
    invariant(await state.acceptsTableFieldValue(nextField, resolution.value), 'table.field-conversion-resolution-invalid', 'Replacement value is incompatible with target Field');
    return resolution.value;
  };
  const defaultFailure = field.defaultValue !== undefined && field.defaultValue !== null && !(await state.acceptsTableFieldValue(nextField, field.defaultValue))
    ? field.defaultValue
    : null;
  const records = await state.tableRecords();
  const possibleFailures = await Promise.all(records.map(async (record) => {
    const value = record.values[field.key];
    return value !== undefined && value !== null && !(await state.acceptsTableFieldValue(nextField, value))
      ? { originalValue: value, recordId: record.id }
      : null;
  }));
  const failures: { originalValue: JsonValue; recordId: string }[] = [];
  for (const failure of possibleFailures) if (failure !== null) failures.push(failure);
  const preview = { defaultFailure, failures, fieldId: field.id, observedVersion: field.version, targetType: input.targetType };
  const requestedResolutions = input.resolutions;
  if (requestedResolutions === undefined && input.defaultResolution === undefined) {
    return sealCanonicalPlan({ field: nextField, previousField: field, preview, purpose: 'preview', recordUpdates: [] }, field.id, field.version);
  }
  invariant((defaultFailure !== null) === (input.defaultResolution !== undefined), 'table.field-conversion-default-unresolved', defaultFailure !== null ? 'Incompatible default value needs one explicit resolution' : 'Default resolution does not match an incompatible default', 409);
  const nextDefault = input.defaultResolution ? await resolveValue(input.defaultResolution) : field.defaultValue;
  nextField = { ...nextField, ...(nextDefault === undefined ? {} : { defaultValue: nextDefault }) };
  const resolutionList = requestedResolutions ?? [];
  const resolutions = new Map(resolutionList.map((resolution) => [resolution.recordId, resolution]));
  invariant(resolutions.size === resolutionList.length, 'table.field-conversion-resolution-duplicate', 'Each Record may have one conversion resolution');
  invariant(failures.length === resolutions.size && failures.every((failure) => resolutions.has(failure.recordId)), 'table.field-conversion-unresolved', 'Every incompatible value needs one explicit resolution', 409);
  const updates = new Map(await Promise.all(failures.map(async (failure) => [failure.recordId, await resolveValue(resolutions.get(failure.recordId)!)] as const)));
  const nextRecords = records.map((record) => updates.has(record.id) ? { ...record, values: { ...record.values, [field.key]: updates.get(record.id)! } } : record);
  const fields = (await state.tableFields()).map((candidate) => candidate.id === field.id ? nextField : candidate);
  for (const record of nextRecords.filter((candidate) => candidate.tombstonedAt === undefined)) {
    await state.validateTableRecordValues(fields, nextRecords, record.values, record.id, true, [field.key]);
  }
  const recordUpdates = failures.map((failure) => {
    const record = records.find((candidate) => candidate.id === failure.recordId)!;
    return {
      observedVersion: record.fieldVersions[field.key] ?? 0,
      ...(Object.hasOwn(record.values, field.key) ? { previousValue: record.values[field.key] } : {}),
      recordId: record.id,
      value: updates.get(record.id)!,
    };
  });
  return sealCanonicalPlan({ field: nextField, previousField: field, preview, purpose: 'execute', recordUpdates }, field.id, field.version);
}

export function validateTableFieldValue(field: TableField, rawValue: unknown): JsonValue {
  const value = jsonValueSchema.parse(rawValue);
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

export const tableChannelType = {
  actions: [
    channelCreateContract,
    contract('table.field.add', z.object({
      cardinality: recordReferenceCardinalitySchema.optional(),
      channelId: channelIdSchema,
      defaultValue: optionalJsonValueSchema,
      key: z.string().regex(/^[a-z][a-z0-9_]*$/),
      label: z.string().trim().min(1).max(120),
      required: z.boolean().default(false),
      targetChannelId: z.string().min(1).optional(),
      type: tableFieldTypeSchema,
      unique: z.boolean().default(false),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Field creation needs Action capabilities');
      const fields = await capabilities.state!.tableFields();
      invariant(!fields.some((field) => field.key === input.key), 'table.field-key-conflict', `Field key already exists: ${input.key}`, 409);
      const allRecords = await capabilities.state!.tableRecords();
      const activeRecords = allRecords.filter((record) => record.tombstonedAt === undefined);
      const isDictionary = input.type === 'dictionary';
      const isReference = input.type === 'record-reference';
      invariant(isReference ? input.targetChannelId !== undefined && input.cardinality !== undefined : input.cardinality === undefined, 'table.field-reference-configuration', 'Record Reference Field requires one target Channel and cardinality');
      invariant(isDictionary ? input.targetChannelId !== undefined : isReference || input.targetChannelId === undefined, 'table.field-dictionary-configuration', 'Dictionary Field requires one target Dictionary Channel');
      const field: TableField = {
        ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
        channelId: input.channelId,
        ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
        id: capabilities.newId('field'), key: input.key, label: input.label, required: input.required,
        ...(input.targetChannelId === undefined ? {} : { targetChannelId: input.targetChannelId }),
        type: input.type, unique: input.unique, version: 1,
      };
      await capabilities.state!.validateTableFieldTarget(field);
      if (input.defaultValue !== undefined) {
        invariant(!(input.required && input.defaultValue === null), 'table.record-required-field', `Required Field cannot default to null: ${input.key}`);
        invariant(input.defaultValue === null || await capabilities.state!.acceptsTableFieldValue(field, input.defaultValue), 'table.field-type', 'Default value does not match Field type');
      }
      invariant(!(input.required && input.defaultValue === undefined && activeRecords.length > 0), 'table.field-required-existing-records', 'Required Field needs a default while Records exist', 409);
      invariant(!(input.unique && input.defaultValue != null && activeRecords.length > 1), 'table.field-unique-default-conflict', 'Unique Field default cannot be applied to multiple Records', 409);
      await capabilities.changes.addTableField!(field);
      if (input.defaultValue !== undefined) for (const record of allRecords) await capabilities.changes.updateTableRecord!({ observedVersions: { [input.key]: 0 }, recordId: record.id, values: { [input.key]: input.defaultValue } });
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['addTableField', 'updateTableRecord']),
    contract('table.field.tombstone', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Field tombstone needs Action capabilities');
      const field = (await capabilities.state!.tableFields()).find((candidate) => candidate.id === input.fieldId);
      invariant(field, 'table.field-not-found', 'Table Field not found', 404);
      invariant(field.tombstonedAt === undefined, 'table.field-already-tombstoned', 'Table Field is already tombstoned', 409);
      invariant(field.version === input.observedVersion, 'table.field-conflict', 'Table Field changed after observation', 409);
      await capabilities.changes.updateTableField!({ fieldId: field.id, kind: 'tombstone', observedVersion: input.observedVersion });
      if (await capabilities.state!.displayFieldId() === field.id) await capabilities.changes.setTableDisplayField!(null);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['updateTableField', 'setTableDisplayField']),
    contract('table.field.restore', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Field restoration needs Action capabilities');
      const field = (await capabilities.state!.tableFields()).find((candidate) => candidate.id === input.fieldId);
      invariant(field, 'table.field-not-found', 'Table Field not found', 404);
      invariant(field.tombstonedAt !== undefined, 'table.field-not-tombstoned', 'Table Field is not tombstoned', 409);
      invariant(field.version === input.observedVersion, 'table.field-conflict', 'Table Field changed after observation', 409);
      await capabilities.changes.updateTableField!({ fieldId: field.id, kind: 'restore', observedVersion: input.observedVersion });
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['updateTableField']),
    contract('table.field.convert', z.object({
      cardinality: recordReferenceCardinalitySchema.optional(),
      cancel: z.boolean().default(false),
      channelId: channelIdSchema,
      defaultResolution: defaultConversionResolutionSchema.optional(),
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
      resolutions: z.array(conversionResolutionSchema).default([]),
      targetChannelId: z.string().min(1).optional(),
      targetType: tableFieldTypeSchema,
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Field conversion needs Action capabilities');
      const field = (await capabilities.state!.tableFields()).find((candidate) => candidate.id === input.fieldId);
      invariant(field, 'table.field-not-found', 'Table Field not found', 404);
      invariant(field.tombstonedAt === undefined, 'table.field-tombstoned', 'Table Field is tombstoned', 409);
      invariant(field.version === input.observedVersion, 'table.field-conflict', 'Table Field changed after observation', 409);
      invariant(field.type !== input.targetType, 'table.field-type-unchanged', 'Target Field type must differ', 409);
      if (input.cancel) {
        invariant(input.resolutions.length === 0 && input.defaultResolution === undefined, 'table.field-conversion-cancelled', 'Cancelled conversion cannot include resolutions');
        return capabilities.cancel!({ id: field.id, kind: 'field' });
      }
      const plan = await capabilities.state!.planTableFieldConversion({
        ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
        ...(input.defaultResolution === undefined ? {} : {
          defaultResolution: {
            kind: input.defaultResolution.kind,
            ...(input.defaultResolution.value === undefined ? {} : { value: input.defaultResolution.value }),
          },
        }),
        fieldId: field.id,
        observedVersion: input.observedVersion,
        resolutions: input.resolutions.map((resolution) => ({
          kind: resolution.kind,
          recordId: resolution.recordId,
          ...(resolution.value === undefined ? {} : { value: resolution.value }),
        })),
        ...(input.targetChannelId === undefined ? {} : { targetChannelId: input.targetChannelId }),
        targetType: input.targetType,
      });
      await capabilities.changes.updateTableField!({
        kind: 'convert',
        plan,
      });
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['cancel', 'updateTableField']),
    contract('table.field.purge', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Field purge needs Action capabilities');
      const field = (await capabilities.state!.tableFields()).find((candidate) => candidate.id === input.fieldId);
      invariant(field, 'table.field-not-found', 'Table Field not found', 404);
      invariant(field.tombstonedAt !== undefined, 'table.field-not-tombstoned', 'Table Field must be tombstoned before purge', 409);
      invariant(field.version === input.observedVersion, 'table.field-conflict', 'Table Field changed after observation', 409);
      await capabilities.changes.purgeTableField!(field.id);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['purgeTableField']),
    contract('table.record.create', z.object({
      channelId: channelIdSchema,
      values: z.record(z.string(), jsonValueSchema),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Record creation needs Action capabilities');
      await capabilities.changes.createTableRecord!(input.values);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['createTableRecord']),
    contract('table.display-field.set', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1).nullable(),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Display Field selection needs Action capabilities');
      await capabilities.changes.setTableDisplayField!(input.fieldId);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['setTableDisplayField']),
    contract('table.record.edit', z.object({
      channelId: channelIdSchema,
      observedVersions: z.record(z.string(), z.number().int().nonnegative()),
      recordId: z.string().min(1),
      values: z.record(z.string(), jsonValueSchema),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Record edit needs Action capabilities');
      const record = await capabilities.state!.tableRecord(input.recordId);
      invariant(record?.channelId === input.channelId, 'table.record-not-found', 'Table Record not found', 404);
      invariant(record.tombstonedAt === undefined, 'table.record-tombstoned', 'Table Record is tombstoned', 409);
      const changedKeys = Object.keys(input.values);
      invariant(changedKeys.length > 0, 'table.record-empty-edit', 'Table Record edit needs at least one Field');
      invariant(changedKeys.every((key) => input.observedVersions[key] !== undefined), 'table.record-observed-version-required', 'Observed version is required for every edited Field');
      for (const key of changedKeys) invariant((record.fieldVersions[key] ?? 0) === input.observedVersions[key], 'table.record-edit-conflict', `Table Field value changed after observation: ${key}`, 409);
      const fields = await capabilities.state!.tableFields();
      const records = await capabilities.state!.tableRecords();
      await capabilities.state!.validateTableRecordValues(fields, records, { ...record.values, ...input.values }, record.id, true, changedKeys);
      await capabilities.changes.updateTableRecord!({
        observedVersions: input.observedVersions,
        recordId: record.id,
        values: input.values,
      });
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['updateTableRecord']),
    contract('table.record.tombstone', z.object({
      channelId: channelIdSchema,
      recordId: z.string().min(1),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Record tombstone needs Action capabilities');
      const record = await capabilities.state!.tableRecord(input.recordId);
      invariant(record?.channelId === input.channelId, 'table.record-not-found', 'Table Record not found', 404);
      invariant(record.tombstonedAt === undefined, 'table.record-already-tombstoned', 'Table Record is already tombstoned', 409);
      await capabilities.changes.tombstoneTableRecord!(record.id, record.updatedAt ?? null);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['tombstoneTableRecord']),
    contract('table.record.restore', z.object({
      channelId: channelIdSchema,
      recordId: z.string().min(1),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table Record restoration needs Action capabilities');
      const record = await capabilities.state!.tableRecord(input.recordId);
      invariant(record?.channelId === input.channelId, 'table.record-not-found', 'Table Record not found', 404);
      invariant(record.tombstonedAt !== undefined, 'table.record-not-tombstoned', 'Table Record is not tombstoned', 409);
      await capabilities.state!.validateTableRecordValues(await capabilities.state!.tableFields(), await capabilities.state!.tableRecords(), record.values, record.id, false);
      await capabilities.changes.restoreTableRecord!(record.id, record.tombstonedAt);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['restoreTableRecord']),
    contract('table.view.create', z.object({
      channelId: channelIdSchema,
      filters: z.array(tableViewFilterSchema).default([]),
      grouping: z.array(z.string().min(1)).default([]),
      name: z.string().trim().min(1).max(120),
      sorting: z.array(tableViewSortSchema).default([]),
      visibility: z.enum(['personal', 'shared']),
      visibleFieldIds: z.array(z.string().min(1)),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Table View creation needs Action capabilities');
      await capabilities.changes.createTableView!({
        filters: input.filters.map((filter) => ({
          fieldId: filter.fieldId,
          operator: filter.operator,
          ...(filter.value === undefined ? {} : { value: filter.value }),
        })),
        grouping: input.grouping,
        name: input.name,
        sorting: input.sorting,
        visibility: input.visibility,
        visibleFieldIds: input.visibleFieldIds,
      });
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'viewer' }, ['createTableView']),
    ...discussionActions,
  ],
  activityFor: (changes) => {
    if (changes.some((change) => change.kind === 'channel.created')) return 'channel.created';
    if (changes.some((change) => ['table.field-added', 'table.field-updated', 'table.field-purged'].includes(change.kind))) return 'table.schema-changed';
    if (changes.some((change) => change.kind === 'table.record-created')) return 'table.record-created';
    if (changes.some((change) => change.kind === 'table.record-updated')) return 'table.record-edited';
    if (changes.some((change) => change.kind === 'table.record-tombstoned')) return 'table.record-tombstoned';
    if (changes.some((change) => change.kind === 'table.record-restored')) return 'table.record-restored';
    if (changes.some((change) => change.kind === 'table.display-field-set')) return 'table.display-field-changed';
    const savedView = changes.find((change) => change.kind === 'table.view-saved');
    if (savedView?.kind === 'table.view-saved') return savedView.view.visibility === 'shared' ? 'table.shared-view-created' : 'table.personal-view-created';
    return discussionActivityFor(changes);
  },
  activityKinds: [
    'channel.created',
    'table.schema-changed',
    'table.record-created',
    'table.record-edited',
    'table.record-tombstoned',
    'table.record-restored',
    'table.display-field-changed',
    'table.shared-view-created',
    'table.personal-view-created',
    ...discussionActivityKinds,
  ],
  id: 'table',
  planTableFieldConversion,
  queries: [
    contract('table.describe', z.object({
      channelId: channelIdSchema,
      includeTombstoned: z.boolean().default(false),
    }), async (input, capabilities) => ({
      data: (await capabilities.state!.tableFields())
        .filter((field) => input.includeTombstoned || field.tombstonedAt === undefined)
        .map((field) => ({
          ...(field.cardinality === undefined ? {} : { cardinality: field.cardinality }),
          id: field.id,
          key: field.key,
          label: field.label,
          required: field.required,
          ...(field.targetChannelId === undefined ? {} : { targetChannelId: field.targetChannelId }),
          ...(field.tombstonedAt === undefined ? {} : { tombstonedAt: field.tombstonedAt }),
          type: field.type,
          unique: field.unique,
          version: field.version,
        })),
      view: pendingView(),
    })),
    contract('table.field.conversion.preview', z.object({
      cardinality: recordReferenceCardinalitySchema.optional(),
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      targetChannelId: z.string().min(1).optional(),
      targetType: tableFieldTypeSchema,
    }), async (input, capabilities) => {
      const plan = await capabilities.state!.planTableFieldConversion({
        ...(input.cardinality === undefined ? {} : { cardinality: input.cardinality }),
        fieldId: input.fieldId,
        observedVersion: (await capabilities.state!.tableFields()).find((candidate) => candidate.id === input.fieldId)?.version ?? 0,
        ...(input.targetChannelId === undefined ? {} : { targetChannelId: input.targetChannelId }),
        targetType: input.targetType,
      });
      return {
        data: plan.preview,
        view: pendingView(),
      };
    }, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('table.configuration', z.object({ channelId: channelIdSchema }), async (_input, capabilities) => ({
      data: { displayFieldId: await capabilities.state!.displayFieldId() },
      view: pendingView(),
    })),
    contract('table.records.list', z.object({
      channelId: channelIdSchema,
      includeTombstonedFields: z.boolean().default(false),
      includeTombstoned: z.boolean().default(false),
    }), async (input, capabilities) => {
      const records = (await capabilities.state!.tableRecords()).filter((record) => input.includeTombstoned || record.tombstonedAt === undefined);
      const fields = await capabilities.state!.tableFields();
      const visibleKeys = new Set(fields.filter((field) => input.includeTombstonedFields || field.tombstonedAt === undefined).map((field) => field.key));
      return {
        data: await Promise.all(records.map(async (record) => ({
          fieldVersions: Object.fromEntries(Object.entries(record.fieldVersions).filter(([key]) => visibleKeys.has(key))),
          id: record.id,
          ...(record.tombstonedAt === undefined ? {} : { tombstonedAt: record.tombstonedAt }),
          values: await capabilities.state!.resolveTableValues(
            fields.filter((field) => visibleKeys.has(field.key)),
            Object.fromEntries(Object.entries(record.values).filter(([key]) => visibleKeys.has(key))),
          ),
        }))),
        view: pendingView(),
      };
    }),
    contract('table.view.open', z.object({
      channelId: channelIdSchema,
      viewId: z.string().min(1),
    }), async (input, capabilities) => {
      if (!('read' in capabilities)) throw new Error('Table View opening needs Query capabilities');
      const definition = (await capabilities.state!.tableViews()).find((view) => view.id === input.viewId);
      invariant(definition, 'table.view-not-found', 'Table View does not exist or is not available', 404);
      const fields = await capabilities.state!.tableFields();
      const keys = new Map(fields.map((field) => [field.id, field.key]));
      const visibleKeys = new Set(definition.visibleFieldIds.map((fieldId) => keys.get(fieldId)).filter((key): key is string => key !== undefined));
      const records = await capabilities.read('table.records.list', { channelId: input.channelId });
      let current: QueryResult = {
        data: (records.data as JsonValue[]).map((record) => {
          if (record === null || Array.isArray(record) || typeof record !== 'object') return record;
          const values = record.values;
          return { ...record, values: values !== null && !Array.isArray(values) && typeof values === 'object' ? Object.fromEntries(Object.entries(values).filter(([key]) => visibleKeys.has(key))) : (values ?? null) };
        }),
        view: pendingView(definition.name),
      };
      current = capabilities.transform(current, { filters: definition.filters.map((filter) => ({ field: keys.get(filter.fieldId) ?? filter.fieldId, operator: filter.operator, ...(filter.value === undefined ? {} : { value: filter.value }) })), kind: 'filter' });
      if (Array.isArray(current.data) && definition.sorting.length > 0) {
        const valueAt = (row: JsonValue, key: string): JsonValue | undefined => row !== null && !Array.isArray(row) && typeof row === 'object' && row.values !== null && !Array.isArray(row.values) && typeof row.values === 'object' ? row.values[key] : undefined;
        current = { ...current, data: [...current.data].sort((left, right) => {
          for (const sort of definition.sorting) {
            const compared = (JSON.stringify(valueAt(left, keys.get(sort.fieldId) ?? sort.fieldId)) ?? '').localeCompare(JSON.stringify(valueAt(right, keys.get(sort.fieldId) ?? sort.fieldId)) ?? '');
            if (compared !== 0) return sort.direction === 'ascending' ? compared : -compared;
          }
          return 0;
        }) };
      }
      return definition.grouping.length === 0 ? current : capabilities.transform(current, { fields: definition.grouping.map((fieldId) => keys.get(fieldId) ?? fieldId), kind: 'group' });
    }),
    contract('table.views.list', z.object({ channelId: channelIdSchema }), async (_input, capabilities) => ({
      data: (await capabilities.state!.tableViews()).map((view) => ({
        filters: [...view.filters], grouping: [...view.grouping], id: view.id, name: view.name,
        ownerId: view.ownerId, sorting: [...view.sorting], visibility: view.visibility,
        visibleFieldIds: [...view.visibleFieldIds],
      })),
      view: pendingView(),
    })),
    ...discussionQueries,
  ],
  recordKinds: ['table-record', 'discussion-message'],
  stateRules: [
    stateRule('record-reference-configuration', (name, rawInput) => {
      if (
        !['table.field.add', 'table.field.convert', 'table.field.conversion.preview'].includes(name)
      ) return;
      const input = rawInput as {
        cardinality?: unknown;
        targetChannelId?: unknown;
        targetType?: unknown;
        type?: unknown;
      };
      const type = input.type ?? input.targetType;
      invariant(
        type !== 'record-reference' ||
          (typeof input.targetChannelId === 'string' &&
            (input.cardinality === 'one' || input.cardinality === 'many')),
        'table.field-reference-configuration',
        'Record Reference Field requires one target Channel and cardinality',
      );
    }),
    stateRule('record-values-use-channel-type-invariants', (name, rawInput) => {
      if (!['table.record.create', 'table.record.edit'].includes(name)) return;
      invariant(
        rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput),
        'table.record-invalid',
        'Table Record input must be an object',
      );
    }, (operation) => {
      if (operation.action === 'table.record.create') {
        invariant(
          operation.changes.some((change) => change.kind === 'table.record-created'),
          'table.transition-invalid',
          'Table Record creation must produce a Table Record transition',
        );
      }
      if (operation.action === 'table.record.edit') {
        invariant(
          operation.changes.some((change) => change.kind === 'table.record-updated'),
          'table.transition-invalid',
          'Table Record edit must produce a Table Record transition',
        );
      }
    }),
  ],
  title: 'Table',
  version: '1.0.0',
  views: [
    {
      bindings: { fields: '$result' },
      commandRoles: {
        'table.field.add': 'admin',
        'table.field.convert': 'admin',
        'table.field.purge': 'admin',
        'table.field.restore': 'admin',
        'table.field.tombstone': 'admin',
      },
      commands: [
        'table.field.add',
        'table.field.tombstone',
        'table.field.restore',
        'table.field.convert',
        'table.field.purge',
        'table.record.create',
      ],
      kind: 'table-schema',
      produce: produceOwnedView,
      query: 'table.describe',
      title: (input) => `${input.channelTitle ?? 'Table'} Fields`,
    },
    {
      bindings: { preview: '$result' },
      commandRoles: { 'table.field.convert': 'admin' },
      commands: ['table.field.convert'],
      kind: 'table',
      produce: produceOwnedView,
      query: 'table.field.conversion.preview',
      title: 'Field Conversion Preview',
    },
    {
      bindings: { configuration: '$result' },
      commandRoles: { 'table.display-field.set': 'admin' },
      commands: ['table.display-field.set'],
      kind: 'value',
      produce: produceOwnedView,
      query: 'table.configuration',
      title: 'Table Configuration',
    },
    {
      bindings: { rows: '$result' },
      commands: [
        'table.record.create',
        'table.record.edit',
        'table.record.tombstone',
        'table.record.restore',
      ],
      kind: 'table-records',
      produce: produceOwnedView,
      query: 'table.records.list',
      title: (input) => input.channelTitle ?? 'Table Records',
    },
    {
      bindings: { rows: '$result' },
      commands: [
        'table.record.create',
        'table.record.edit',
        'table.record.tombstone',
        'table.record.restore',
      ],
      kind: 'table-records',
      produce: produceOwnedView,
      query: 'table.view.open',
      title: (input) => input.resultTitle ?? 'Table View',
    },
    {
      bindings: { views: '$result' },
      commandRoles: { 'table.view.create': 'viewer' },
      commands: ['table.view.create'],
      kind: 'table-views',
      produce: produceOwnedView,
      query: 'table.views.list',
      title: 'Table Views',
    },
    discussionView,
    {
      bindings: { revisions: '$result' },
      commands: [],
      kind: 'table',
      produce: produceOwnedView,
      query: 'discussion.message.revisions',
      title: (input) => `${input.channelTitle ?? 'Channel'} Message Revisions`,
    },
  ],
} as const satisfies ChannelTypeDefinition;
