import * as z from 'zod/v4';

import type { ChannelTypeDefinition } from '../channel-types';
import {
  channelCreateContract,
  channelIdSchema,
  contract,
  produceOwnedView,
  stateRule,
} from './contract';
import { invariant } from '../errors';
import {
  discussionActions,
  discussionActivityKinds,
  discussionActivityFor,
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
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) return capabilities.execute(input);
      await capabilities.changes.createDictionaryEntry!(input.label);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['dictionary.entry.create']),
    contract('dictionary.entry.rename', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
      label: dictionaryLabelSchema,
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    contract('dictionary.entry.retire', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    contract('dictionary.entry.restore', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
    }), undefined, { kind: 'channel-role', minimumRole: 'contributor' }),
    ...discussionActions,
  ],
  activityFor: (changes) => {
    if (changes.some((change) => change.kind === 'channel.created')) return 'channel.created';
    if (changes.some((change) => change.kind === 'dictionary.entry-created')) return 'dictionary.entry-created';
    if (changes.some((change) => change.kind === 'dictionary.entry-renamed')) return 'dictionary.entry-renamed';
    if (changes.some((change) => change.kind === 'dictionary.entry-retired')) return 'dictionary.entry-retired';
    if (changes.some((change) => change.kind === 'dictionary.entry-restored')) return 'dictionary.entry-restored';
    return discussionActivityFor(changes);
  },
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
    stateRule('entry-labels-are-normalized', (name, rawInput) => {
      if (!['dictionary.entry.create', 'dictionary.entry.rename'].includes(name)) return;
      const label = (rawInput as { label?: unknown }).label;
      invariant(
        typeof label === 'string' && label === normalizeDictionaryLabel(label),
        'dictionary.label-invalid',
        'Dictionary Entry label must be normalized',
      );
    }, (operation) => {
      for (const change of operation.changes) {
        if (change.kind !== 'dictionary.entry-created' && change.kind !== 'dictionary.entry-renamed') continue;
        invariant(
          change.kind === 'dictionary.entry-created'
            ? change.entry.label === normalizeDictionaryLabel(change.entry.label)
            : change.label === normalizeDictionaryLabel(change.label),
          'dictionary.transition-invalid',
          'Dictionary transitions must preserve normalized labels',
        );
      }
    }),
  ],
  title: 'Dictionary',
  version: '1.0.0',
  views: [
    {
      bindings: { entries: '$result' },
      commands: [
        'dictionary.entry.create',
        'dictionary.entry.rename',
        'dictionary.entry.retire',
        'dictionary.entry.restore',
      ],
      kind: 'dictionary',
      produce: produceOwnedView,
      query: 'dictionary.entries.list',
      title: 'Dictionary Entries',
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
