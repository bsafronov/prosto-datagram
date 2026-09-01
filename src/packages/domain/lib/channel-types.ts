import * as z from 'zod/v4';

import { chartChannelType } from './channel-type-modules/chart';
import { dictionaryChannelType } from './channel-type-modules/dictionary';
import { tableChannelType } from './channel-type-modules/table';
import { DatagramError } from './errors';
import { viewDefinitionSchema, type Operation, type ViewDefinition } from './model';

export { dictionaryLabelKey, normalizeDictionaryLabel } from './channel-type-modules/dictionary';
export { validateTableFieldValue } from './channel-type-modules/table';

const channelContractSchema = z.object({
  inputSchema: z.custom<z.ZodType>(
    (value) => typeof (value as { parse?: unknown } | null)?.parse === 'function',
  ),
  name: z.string().min(1),
});

const channelStateRuleSchema = z.object({
  name: z.string().min(1),
  validate: z.custom<(contract: string, input: unknown) => void>(
    (value) => typeof value === 'function',
  ),
  validateTransition: z.custom<(operation: Operation) => void>(
    (value) => value === undefined || typeof value === 'function',
  ).optional(),
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

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const object = value as object;
  if ('_zod' in object) return value;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
};

const snapshotSchema = (root: z.ZodType): z.ZodType => {
  const schemas = new WeakMap<object, z.ZodType>();
  const values = new WeakMap<object, unknown>();
  const snapshotValue = (value: unknown): unknown => {
    if (value && typeof value === 'object' && '_zod' in value) {
      return snapshotNode(value as z.ZodType);
    }
    if (Array.isArray(value)) {
      const existing = values.get(value);
      if (existing) return existing;
      const result: unknown[] = [];
      values.set(value, result);
      result.push(...value.map(snapshotValue));
      return result;
    }
    if (value && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      const existing = values.get(value);
      if (existing) return existing;
      const result: Record<string, unknown> = {};
      values.set(value, result);
      for (const [key, child] of Object.entries(value)) result[key] = snapshotValue(child);
      return result;
    }
    return value;
  };
  const snapshotNode = (schema: z.ZodType): z.ZodType => {
    const existing = schemas.get(schema);
    if (existing) return existing;
    schemas.set(schema, z.clone(schema));
    const result = z.clone(schema, snapshotValue(schema._zod.def) as typeof schema._zod.def);
    schemas.set(schema, result);
    return result;
  };
  return snapshotNode(root);
};

const publicContract = (
  name: string,
  schema: z.ZodType,
): { readonly inputSchema: z.ZodType; readonly name: string } =>
  Object.defineProperties(
    { name },
    {
      inputSchema: {
        enumerable: true,
        get: () => snapshotSchema(schema),
      },
    },
  ) as { readonly inputSchema: z.ZodType; readonly name: string };

export const channelTypeDefinitionSchema = z.object({
  actions: z.array(channelContractSchema),
  activityKinds: z.array(z.string()),
  id: z.string().min(1),
  queries: z.array(channelContractSchema),
  recordKinds: z.array(z.enum(['dictionary-entry', 'discussion-message', 'table-record'])),
  stateRules: z.array(channelStateRuleSchema),
  title: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  views: z.array(z.object({
    commands: z.array(z.string()),
    kind: z.string().min(1),
    produce: z.custom<(candidate: ViewDefinition) => ViewDefinition>(
      (value) => value === undefined || typeof value === 'function',
    ).optional(),
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
  readonly #schemas = new Map<string, z.ZodType>();
  readonly #versions = new Map<string, ChannelTypeDefinition[]>();

  constructor(definitions: readonly ChannelTypeDefinition[]) {
    for (const candidate of definitions) {
      const parsed = channelTypeDefinitionSchema.parse(candidate);
      const definition = {
        ...parsed,
        actions: parsed.actions.map((contract) => {
          const schema = snapshotSchema(contract.inputSchema);
          this.#schemas.set(
            `action:${ChannelTypeRegistry.key(parsed.id, parsed.version)}:${contract.name}`,
            schema,
          );
          return publicContract(contract.name, schema);
        }),
        queries: parsed.queries.map((contract) => {
          const schema = snapshotSchema(contract.inputSchema);
          this.#schemas.set(
            `query:${ChannelTypeRegistry.key(parsed.id, parsed.version)}:${contract.name}`,
            schema,
          );
          return publicContract(contract.name, schema);
        }),
      } satisfies ChannelTypeDefinition;
      const key = ChannelTypeRegistry.key(definition.id, definition.version);
      if (this.#definitions.has(key)) {
        throw new DatagramError(
          'channel-type.duplicate',
          `Duplicate Channel Type version: ${definition.id}@${definition.version}`,
        );
      }
      const frozen = deepFreeze(definition);
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
    this.require(id, version);
    const schema = this.#schemas.get(`action:${ChannelTypeRegistry.key(id, version)}:${name}`);
    return schema ? snapshotSchema(schema) : undefined;
  }

  requireQuery(id: string, version: string, name: string): z.ZodType | undefined {
    this.require(id, version);
    const schema = this.#schemas.get(`query:${ChannelTypeRegistry.key(id, version)}:${name}`);
    return schema ? snapshotSchema(schema) : undefined;
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

  validateState(id: string, version: string, contract: string, input: unknown): void {
    for (const rule of this.require(id, version).stateRules) rule.validate(contract, input);
  }

  validateTransition(id: string, version: string, operation: Operation): void {
    for (const rule of this.require(id, version).stateRules) rule.validateTransition?.(operation);
  }

  produceView(
    id: string,
    version: string,
    query: string,
    candidate: ViewDefinition,
  ): ViewDefinition {
    const definition = this.require(id, version);
    const declared = definition.views.find((candidate) => candidate.query === query);
    if (!declared) {
      throw new DatagramError(
        'channel-type.view-undeclared',
        `Channel Type Query has no View Definition: ${id}@${version}:${query}`,
      );
    }
    const view = viewDefinitionSchema.parse(declared.produce?.(candidate) ?? candidate);
    if (
      declared.kind !== view.kind ||
      view.commands.some((command) => !declared.commands.includes(command))
    ) {
      throw new DatagramError(
        'channel-type.view-invalid',
        `Query result does not match Channel Type View Definition: ${id}@${version}:${query}`,
      );
    }
    return view;
  }

  static key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}
