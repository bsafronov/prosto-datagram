import * as z from 'zod/v4';

import { chartChannelType } from './channel-type-modules/chart';
import { dictionaryChannelType } from './channel-type-modules/dictionary';
import { tableChannelType } from './channel-type-modules/table';
import { DatagramError } from './errors';
import type { ViewDefinition } from './model';

export { dictionaryLabelKey, normalizeDictionaryLabel } from './channel-type-modules/dictionary';
export { validateTableFieldValue } from './channel-type-modules/table';

const channelContractSchema = z.object({
  inputSchema: z.custom<z.ZodType>(
    (value) => typeof (value as { parse?: unknown } | null)?.parse === 'function',
  ),
  name: z.string().min(1),
});

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const compared = leftParts[index]! - rightParts[index]!;
    if (compared !== 0) return compared;
  }
  return 0;
};

export const channelTypeDefinitionSchema = z.object({
  actions: z.array(channelContractSchema),
  activityKinds: z.array(z.string()),
  id: z.string().min(1),
  queries: z.array(channelContractSchema),
  recordKinds: z.array(z.enum(['dictionary-entry', 'discussion-message', 'table-record'])),
  stateRules: z.array(z.string()),
  title: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  views: z.array(z.object({
    commands: z.array(z.string()),
    kind: z.string().min(1),
    query: z.string().min(1),
  })),
});

export type ChannelTypeDefinition = z.infer<typeof channelTypeDefinitionSchema>;

export const bundledChannelTypes: readonly ChannelTypeDefinition[] = [
  tableChannelType,
  dictionaryChannelType,
  chartChannelType,
];

export class ChannelTypeRegistry {
  readonly #definitions = new Map<string, ChannelTypeDefinition>();
  readonly #versions = new Map<string, ChannelTypeDefinition[]>();

  constructor(definitions: readonly ChannelTypeDefinition[]) {
    for (const candidate of definitions) {
      const definition = channelTypeDefinitionSchema.parse(candidate);
      const key = ChannelTypeRegistry.key(definition.id, definition.version);
      if (this.#definitions.has(key)) {
        throw new DatagramError(
          'channel-type.duplicate',
          `Duplicate Channel Type version: ${definition.id}@${definition.version}`,
        );
      }
      const frozen = Object.freeze(definition);
      this.#definitions.set(key, frozen);
      this.#versions.set(
        definition.id,
        [...(this.#versions.get(definition.id) ?? []), frozen].sort((left, right) =>
          compareVersions(left.version, right.version),
        ),
      );
    }
  }

  list(): readonly ChannelTypeDefinition[] {
    return [...this.#definitions.values()];
  }

  require(id: string, version: string): ChannelTypeDefinition {
    const definition = this.#definitions.get(ChannelTypeRegistry.key(id, version));
    if (!definition) {
      throw new DatagramError(
        'channel-type.version-unavailable',
        `Channel Type version is not installed: ${id}@${version}`,
        409,
      );
    }
    return definition;
  }

  requireCurrent(id: string): ChannelTypeDefinition {
    const definitions = this.#versions.get(id);
    if (!definitions?.length) {
      throw new DatagramError('channel-type.unknown', `Unknown Channel Type: ${id}`, 404);
    }
    return definitions.at(-1)!;
  }

  requireAction(id: string, version: string, name: string): z.ZodType | undefined {
    return this.require(id, version).actions.find((contract) => contract.name === name)?.inputSchema;
  }

  requireQuery(id: string, version: string, name: string): z.ZodType | undefined {
    return this.require(id, version).queries.find((contract) => contract.name === name)?.inputSchema;
  }

  assertImplementations(
    actionNames: ReadonlySet<string>,
    queryNames: ReadonlySet<string>,
  ): void {
    for (const definition of this.#definitions.values()) {
      for (const action of definition.actions) {
        if (!actionNames.has(action.name)) {
          throw new DatagramError(
            'channel-type.action-unimplemented',
            `Channel Type Action is not implemented: ${definition.id}@${definition.version}:${action.name}`,
          );
        }
      }
      for (const query of definition.queries) {
        if (!queryNames.has(query.name)) {
          throw new DatagramError(
            'channel-type.query-unimplemented',
            `Channel Type Query is not implemented: ${definition.id}@${definition.version}:${query.name}`,
          );
        }
      }
    }
  }

  assertView(
    id: string,
    version: string,
    query: string,
    view: ViewDefinition,
  ): void {
    const definition = this.require(id, version);
    const declared = definition.views.find((candidate) => candidate.query === query);
    if (!declared) {
      throw new DatagramError(
        'channel-type.view-undeclared',
        `Channel Type Query has no View Definition: ${id}@${version}:${query}`,
      );
    }
    if (
      declared.kind !== view.kind ||
      view.commands.some((command) => !declared.commands.includes(command))
    ) {
      throw new DatagramError(
        'channel-type.view-invalid',
        `Query result does not match Channel Type View Definition: ${id}@${version}:${query}`,
      );
    }
  }

  static key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}
