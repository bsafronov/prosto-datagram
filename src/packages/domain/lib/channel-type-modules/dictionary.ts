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
      if (!('changes' in capabilities)) throw new Error('Dictionary creation needs Action capabilities');
      const normalizedLabel = dictionaryLabelKey(input.label);
      invariant(
        !(await capabilities.state!.dictionaryEntries()).some(
          (entry) => entry.normalizedLabel === normalizedLabel,
        ),
        'dictionary.entry-label-conflict',
        'Dictionary Entry label already exists',
        409,
      );
      await capabilities.changes.createDictionaryEntry!(input.label);
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['createDictionaryEntry']),
    contract('dictionary.entry.rename', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
      label: dictionaryLabelSchema,
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Dictionary rename needs Action capabilities');
      const entry = await capabilities.state!.dictionaryEntry(input.entryId);
      invariant(entry?.channelId === input.channelId, 'dictionary.entry-not-found', 'Dictionary Entry not found', 404);
      const normalizedLabel = dictionaryLabelKey(input.label);
      invariant(
        !(await capabilities.state!.dictionaryEntries()).some(
          (candidate) => candidate.id !== entry.id && candidate.normalizedLabel === normalizedLabel,
        ),
        'dictionary.entry-label-conflict',
        'Dictionary Entry label already exists',
        409,
      );
      capabilities.changes.renameDictionaryEntry!({
        entryId: entry.id,
        label: input.label,
        normalizedLabel,
        updatedAt: capabilities.now(),
      });
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['renameDictionaryEntry']),
    contract('dictionary.entry.retire', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Dictionary retirement needs Action capabilities');
      const entry = await capabilities.state!.dictionaryEntry(input.entryId);
      invariant(entry?.channelId === input.channelId, 'dictionary.entry-not-found', 'Dictionary Entry not found', 404);
      invariant(entry.retiredAt === undefined, 'dictionary.entry-retired', 'Dictionary Entry is already retired', 409);
      capabilities.changes.retireDictionaryEntry!(entry.id, capabilities.now());
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['retireDictionaryEntry']),
    contract('dictionary.entry.restore', z.object({
      channelId: channelIdSchema,
      entryId: z.string().min(1),
    }), async (input, capabilities) => {
      if (!('changes' in capabilities)) throw new Error('Dictionary restoration needs Action capabilities');
      const entry = await capabilities.state!.dictionaryEntry(input.entryId);
      invariant(entry?.channelId === input.channelId, 'dictionary.entry-not-found', 'Dictionary Entry not found', 404);
      invariant(entry.retiredAt !== undefined, 'dictionary.entry-active', 'Dictionary Entry is not retired', 409);
      capabilities.changes.restoreDictionaryEntry!(entry.id, capabilities.now());
      return capabilities.commit();
    }, { kind: 'channel-role', minimumRole: 'contributor' }, ['restoreDictionaryEntry']),
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
    }), async (input, capabilities) => {
      const entries = (await capabilities.state!.dictionaryEntries()).filter(
        (entry) => input.includeRetired || entry.retiredAt === undefined,
      );
      return {
        data: entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          ...(entry.retiredAt === undefined ? {} : { retiredAt: entry.retiredAt }),
        })),
        view: { bindings: {}, commands: [], kind: 'pending', schemaVersion: 'datagram/view@1', title: 'Channel Type View' },
      };
    }),
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
