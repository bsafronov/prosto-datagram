import * as z from 'zod/v4';

import type { ChannelTypeDefinition } from '../channel-types';
import {
  jsonValueSchema,
  recordReferenceCardinalitySchema,
  tableFieldTypeSchema,
  type JsonValue,
  type TableField,
} from '../model';
import { DatagramError, invariant } from '../errors';
import {
  channelCreateContract,
  channelIdSchema,
  contract,
  produceOwnedView,
  stateRule,
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
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('table.field.tombstone', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('table.field.restore', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
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
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('table.field.purge', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('table.record.create', z.object({
      channelId: channelIdSchema,
      values: z.record(z.string(), jsonValueSchema),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) return capabilities.execute(input);
      await capabilities.changes.createTableRecord!(input.values);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['table.record.create']),
    contract('table.display-field.set', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1).nullable(),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) return capabilities.execute(input);
      await capabilities.changes.setTableDisplayField!(input.fieldId);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'admin' }, ['table.display-field.set']),
    contract('table.record.edit', z.object({
      channelId: channelIdSchema,
      observedVersions: z.record(z.string(), z.number().int().nonnegative()),
      recordId: z.string().min(1),
      values: z.record(z.string(), jsonValueSchema),
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    contract('table.record.tombstone', z.object({
      channelId: channelIdSchema,
      recordId: z.string().min(1),
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    contract('table.record.restore', z.object({
      channelId: channelIdSchema,
      recordId: z.string().min(1),
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    contract('table.view.create', z.object({
      channelId: channelIdSchema,
      filters: z.array(tableViewFilterSchema).default([]),
      grouping: z.array(z.string().min(1)).default([]),
      name: z.string().trim().min(1).max(120),
      sorting: z.array(tableViewSortSchema).default([]),
      visibility: z.enum(['personal', 'shared']),
      visibleFieldIds: z.array(z.string().min(1)),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) return capabilities.execute(input);
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
    }, { kind: 'channel-role', minimumRole: 'viewer' }, ['table.view.create']),
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
  queries: [
    contract('table.describe', z.object({
      channelId: channelIdSchema,
      includeTombstoned: z.boolean().default(false),
    })),
    contract('table.field.conversion.preview', z.object({
      cardinality: recordReferenceCardinalitySchema.optional(),
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      targetChannelId: z.string().min(1).optional(),
      targetType: tableFieldTypeSchema,
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('table.configuration', z.object({ channelId: channelIdSchema })),
    contract('table.records.list', z.object({
      channelId: channelIdSchema,
      includeTombstonedFields: z.boolean().default(false),
      includeTombstoned: z.boolean().default(false),
    })),
    contract('table.view.open', z.object({
      channelId: channelIdSchema,
      viewId: z.string().min(1),
    })),
    contract('table.views.list', z.object({ channelId: channelIdSchema })),
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
      title: 'Table View',
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
