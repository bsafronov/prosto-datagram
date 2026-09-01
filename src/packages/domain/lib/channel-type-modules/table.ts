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
import { channelCreateContract, channelIdSchema, contract } from './contract';
import {
  discussionActions,
  discussionActivityKinds,
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
    })),
    contract('table.field.tombstone', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    })),
    contract('table.field.restore', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    })),
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
    })),
    contract('table.field.purge', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1),
      observedVersion: z.number().int().positive(),
    })),
    contract('table.record.create', z.object({
      channelId: channelIdSchema,
      values: z.record(z.string(), jsonValueSchema),
    })),
    contract('table.display-field.set', z.object({
      channelId: channelIdSchema,
      fieldId: z.string().min(1).nullable(),
    })),
    contract('table.record.edit', z.object({
      channelId: channelIdSchema,
      observedVersions: z.record(z.string(), z.number().int().nonnegative()),
      recordId: z.string().min(1),
      values: z.record(z.string(), jsonValueSchema),
    })),
    contract('table.record.tombstone', z.object({
      channelId: channelIdSchema,
      recordId: z.string().min(1),
    })),
    contract('table.record.restore', z.object({
      channelId: channelIdSchema,
      recordId: z.string().min(1),
    })),
    contract('table.view.create', z.object({
      channelId: channelIdSchema,
      filters: z.array(tableViewFilterSchema).default([]),
      grouping: z.array(z.string().min(1)).default([]),
      name: z.string().trim().min(1).max(120),
      sorting: z.array(tableViewSortSchema).default([]),
      visibility: z.enum(['personal', 'shared']),
      visibleFieldIds: z.array(z.string().min(1)),
    })),
    ...discussionActions,
  ],
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
    })),
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
    'fields-own-validation-and-conversion',
    'records-preserve-stable-identity',
    'record-mutations-require-contributor',
  ],
  title: 'Table',
  version: '1.0.0',
  views: [
    {
      commands: [
        'table.field.add',
        'table.field.tombstone',
        'table.field.restore',
        'table.field.convert',
        'table.field.purge',
        'table.record.create',
      ],
      kind: 'table-schema',
      query: 'table.describe',
    },
    {
      commands: ['table.field.convert'],
      kind: 'table',
      query: 'table.field.conversion.preview',
    },
    {
      commands: ['table.display-field.set'],
      kind: 'value',
      query: 'table.configuration',
    },
    {
      commands: [
        'table.record.create',
        'table.record.edit',
        'table.record.tombstone',
        'table.record.restore',
      ],
      kind: 'table-records',
      query: 'table.records.list',
    },
    {
      commands: [
        'table.record.create',
        'table.record.edit',
        'table.record.tombstone',
        'table.record.restore',
      ],
      kind: 'table-records',
      query: 'table.view.open',
    },
    { commands: ['table.view.create'], kind: 'table-views', query: 'table.views.list' },
    discussionView,
    { commands: [], kind: 'table', query: 'discussion.message.revisions' },
  ],
} as const satisfies ChannelTypeDefinition;
