import * as z from 'zod/v4';

import type { ChannelTypeDefinition } from '../channel-types';
import { jsonValueSchema } from '../model';
import { channelIdSchema, contract } from './contract';
import {
  discussionActions,
  discussionActivityKinds,
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
    })),
    contract('chart.definition.update', z.object({
      aggregations: z.array(chartAggregationSchema).min(1),
      channelId: channelIdSchema,
      filters: z.array(chartFilterSchema).default([]),
      grouping: z.array(z.string().min(1)).default([]),
      observedVersion: z.number().int().positive(),
      presentation: chartPresentationSchema,
      sourceChannelId: z.string().min(1),
    })),
    contract('chart.event.record', z.object({
      channelId: channelIdSchema,
      kind: z.enum(['insight', 'report', 'threshold']),
    })),
    ...discussionActions,
  ],
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
    'definition-retains-live-source-query',
    'source-access-is-rechecked-on-open',
    'ordinary-source-changes-produce-no-chart-activity',
  ],
  title: 'Chart',
  version: '1.0.0',
  views: [
    {
      commands: ['chart.definition.update', 'chart.event.record'],
      kind: 'chart',
      query: 'chart.open',
    },
    discussionView,
    { commands: [], kind: 'table', query: 'discussion.message.revisions' },
  ],
} as const satisfies ChannelTypeDefinition;
