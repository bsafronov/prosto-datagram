import * as z from 'zod/v4';

import { DatagramError } from './errors';

export const channelTypeDefinitionSchema = z.object({
  actions: z.array(z.string()),
  activityKinds: z.array(z.string()),
  id: z.string().min(1),
  title: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  views: z.array(z.enum(['chart', 'discussion', 'table', 'value'])),
});

export type ChannelTypeDefinition = z.infer<typeof channelTypeDefinitionSchema>;

const discussionActions = [
  'discussion.message.post',
  'discussion.message.edit',
  'discussion.message.tombstone',
  'discussion.message.restore',
] as const;

const discussionActivityKinds = [
  'discussion.message-posted',
  'discussion.message-edited',
  'discussion.message-tombstoned',
  'discussion.message-restored',
] as const;

export const bundledChannelTypes: readonly ChannelTypeDefinition[] = [
  {
    actions: [
      'channel.create',
      'table.field.add',
      'table.record.create',
      ...discussionActions,
    ],
    activityKinds: [
      'channel.created',
      'table.schema-changed',
      'table.record-created',
      ...discussionActivityKinds,
    ],
    id: 'table',
    title: 'Table',
    version: '1.0.0',
    views: ['table', 'discussion'],
  },
  {
    actions: ['channel.create', ...discussionActions],
    activityKinds: ['channel.created', 'dictionary.entry-added', ...discussionActivityKinds],
    id: 'dictionary',
    title: 'Dictionary',
    version: '1.0.0',
    views: ['table', 'discussion'],
  },
  {
    actions: ['channel.create', ...discussionActions],
    activityKinds: ['channel.created', 'chart.insight-produced', ...discussionActivityKinds],
    id: 'chart',
    title: 'Chart',
    version: '1.0.0',
    views: ['chart', 'discussion'],
  },
] as const;

export class ChannelTypeRegistry {
  readonly #definitions = new Map<string, ChannelTypeDefinition>();

  constructor(definitions: readonly ChannelTypeDefinition[]) {
    for (const candidate of definitions) {
      const definition = channelTypeDefinitionSchema.parse(candidate);
      if (this.#definitions.has(definition.id)) {
        throw new DatagramError(
          'channel-type.duplicate',
          `Duplicate Channel Type: ${definition.id}`,
        );
      }
      this.#definitions.set(definition.id, Object.freeze(definition));
    }
  }

  list(): readonly ChannelTypeDefinition[] {
    return [...this.#definitions.values()];
  }

  require(id: string): ChannelTypeDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new DatagramError('channel-type.unknown', `Unknown Channel Type: ${id}`, 404);
    }
    return definition;
  }
}
