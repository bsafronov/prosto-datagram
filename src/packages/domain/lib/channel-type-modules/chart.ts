import * as z from 'zod/v4';

import type { ChannelTypeDefinition } from '../channel-types';
import { jsonValueSchema } from '../model';
import { channelIdSchema, contract, produceOwnedView, stateRule } from './contract';
import { invariant } from '../errors';
import {
  discussionActions,
  discussionActivityKinds,
  discussionActivityFor,
  discussionQueries,
  discussionView,
} from './discussion';

const optionalJsonValueSchema = jsonValueSchema.optional();
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

export const chartChannelType = {
  actions: [
    contract('chart.create', z.object({
      handleId: z.string().min(1),
      presentation: chartPresentationSchema,
      title: z.string().trim().min(1).max(160),
      typeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) return capabilities.execute(input);
      return capabilities.changes.createChart!({
        handleId: input.handleId,
        presentation: {
          ...(input.presentation.categoryField === undefined
            ? {}
            : { categoryField: input.presentation.categoryField }),
          series: input.presentation.series,
          type: input.presentation.type,
        },
        title: input.title,
        ...(input.typeVersion === undefined ? {} : { typeVersion: input.typeVersion }),
      });
    }, { kind: 'authenticated' }, ['chart.create']),
    contract('chart.definition.update', z.object({
      aggregations: z.array(chartAggregationSchema).min(1),
      channelId: channelIdSchema,
      filters: z.array(chartFilterSchema).default([]),
      grouping: z.array(z.string().min(1)).default([]),
      observedVersion: z.number().int().positive(),
      presentation: chartPresentationSchema,
      sourceChannelId: z.string().min(1),
    }), undefined, { kind: 'channel-role', minimumRole: 'admin' }),
    contract('chart.event.record', z.object({
      channelId: channelIdSchema,
      kind: z.enum(['insight', 'report', 'threshold']),
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    ...discussionActions,
  ],
  activityFor: (changes) => {
    if (changes.some((change) => change.kind === 'channel.created')) return 'channel.created';
    if (changes.some((change) => change.kind === 'chart.definition-set')) return 'chart.definition-changed';
    const appended = changes.find((change) => change.kind === 'activity.appended');
    return appended?.kind === 'activity.appended'
      ? appended.activity.kind
      : discussionActivityFor(changes);
  },
  activityKinds: [
    'channel.created',
    'chart.definition-changed',
    'chart.insight-produced',
    'chart.threshold-crossed',
    'chart.report-produced',
    ...discussionActivityKinds,
  ],
  id: 'chart',
  queries: [contract('chart.open', z.object({ channelId: channelIdSchema })), ...discussionQueries],
  recordKinds: ['discussion-message'],
  stateRules: [
    stateRule('aggregation-names-are-unique', (name, rawInput) => {
      if (name !== 'chart.definition.update') return;
      const aggregations = (rawInput as { aggregations?: Array<{ as?: unknown }> }).aggregations;
      invariant(
        Array.isArray(aggregations) &&
          new Set(aggregations.map((aggregation) => aggregation.as)).size === aggregations.length,
        'chart.definition-invalid-aggregation',
        'Chart needs uniquely named aggregations',
      );
    }, (operation) => {
      const transition = operation.changes.find(
        (change) => change.kind === 'chart.definition-set',
      );
      if (transition?.kind !== 'chart.definition-set') return;
      invariant(
        new Set(transition.definition.aggregations.map((aggregation) => aggregation.as)).size ===
          transition.definition.aggregations.length,
        'chart.transition-invalid',
        'Chart transitions need uniquely named aggregations',
      );
    }),
  ],
  title: 'Chart',
  version: '1.0.0',
  views: [
    {
      bindings: { presentation: '$result.presentation', series: '$result.series' },
      commandRoles: {
        'chart.definition.update': 'admin',
        'chart.event.record': 'contributor',
      },
      commands: ['chart.definition.update', 'chart.event.record'],
      kind: 'chart',
      produce: produceOwnedView,
      query: 'chart.open',
      title: (input) => input.channelTitle ?? 'Chart',
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
