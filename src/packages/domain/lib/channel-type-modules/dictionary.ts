import * as z from 'zod/v4';

import type { ChannelTypeDefinition } from '../channel-types';
import { channelCreateContract, channelIdSchema, contract } from './contract';
import {
  discussionActions,
  discussionActivityKinds,
  discussionQueries,
  discussionView,
} from './discussion';

export const normalizeDictionaryLabel = (value: string): string => value.trim().normalize('NFC');

export const dictionaryLabelKey = (value: string): string =>
  normalizeDictionaryLabel(value)
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');

const dictionaryLabelSchema = z
  .string()
  .transform(normalizeDictionaryLabel)
  .pipe(z.string().min(1).max(160));

export const dictionaryChannelType = {
  actions: [
    channelCreateContract,
    contract('dictionary.entry.create', z.object({
      channelId: channelIdSchema,
      label: dictionaryLabelSchema,
    })),
    contract('dictionary.entry.rename', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
      label: dictionaryLabelSchema,
    })),
    contract('dictionary.entry.retire', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
    })),
    contract('dictionary.entry.restore', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
    })),
    ...discussionActions,
  ],
  activityKinds: [
    'channel.created',
    'dictionary.entry-created',
    'dictionary.entry-renamed',
    'dictionary.entry-retired',
    'dictionary.entry-restored',
    ...discussionActivityKinds,
  ],
  id: 'dictionary',
  queries: [
    contract('dictionary.entries.list', z.object({
      channelId: channelIdSchema,
      includeRetired: z.boolean().default(false),
    })),
    ...discussionQueries,
  ],
  recordKinds: ['dictionary-entry', 'discussion-message'],
  stateRules: [
    'entry-labels-are-normalized-and-unique',
    'retired-entries-remain-resolvable',
  ],
  title: 'Dictionary',
  version: '1.0.0',
  views: [
    {
      commands: [
        'dictionary.entry.create',
        'dictionary.entry.rename',
        'dictionary.entry.retire',
        'dictionary.entry.restore',
      ],
      kind: 'dictionary',
      query: 'dictionary.entries.list',
    },
    discussionView,
    { commands: [], kind: 'table', query: 'discussion.message.revisions' },
  ],
} as const satisfies ChannelTypeDefinition;
