import * as z from 'zod/v4';

import { chartChannelType } from './channel-type-modules/chart';
import type {
  ChannelActionCapabilities,
  ChannelQueryCapabilities,
  ChannelTypeStatePort,
  ChannelViewDeclaration,
  ChannelViewInput,
} from './channel-type-modules/contract';
import { dictionaryChannelType } from './channel-type-modules/dictionary';
import { tableChannelType } from './channel-type-modules/table';
import type {
  SealTableFieldConversionPlan,
  TableFieldConversionInput,
  TrustedTableFieldConversionPlan,
} from './channel-type-modules/table';
import { DatagramError, invariant } from './errors';
import {
  viewDefinitionSchema,
  type ChannelRole,
  type DomainChange,
  type Operation,
  type ViewDefinition,
} from './model';

export { dictionaryLabelKey, normalizeDictionaryLabel } from './channel-type-modules/dictionary';
export { validateTableFieldValue } from './channel-type-modules/table';
export type { ChannelViewDeclaration, ChannelViewInput } from './channel-type-modules/contract';

const channelContractSchema = z.object({
  allowedOperations: z.array(z.enum([
    'addTableField', 'cancel', 'createChannel', 'createChart', 'createDictionaryEntry',
    'createTableRecord', 'createTableView', 'editDiscussionMessage',
    'postDiscussionMessage', 'purgeTableField', 'recordChartEvent',
    'renameDictionaryEntry', 'restoreDictionaryEntry', 'restoreDiscussionMessage',
    'restoreTableRecord', 'retireDictionaryEntry', 'setChartDefinition',
    'setTableDisplayField', 'tombstoneDiscussionMessage', 'tombstoneTableRecord',
    'updateTableField', 'updateTableRecord',
  ])),
  authorization: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('authenticated') }),
    z.object({ kind: z.literal('message-author-or-admin') }),
    z.object({ kind: z.literal('operator') }),
    z.object({ kind: z.literal('channel-role'), minimumRole: z.enum(['viewer', 'contributor', 'admin', 'owner']) }),
  ]),
  execute: z.custom<(
    input: any,
    capabilities: ChannelActionCapabilities | ChannelQueryCapabilities,
  ) => Promise<any>>(
    (value) => typeof value === 'function',
  ),
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
  allowedOperations: ChannelTypeDefinition['actions'][number]['allowedOperations'],
  authorization: ChannelTypeDefinition['actions'][number]['authorization'],
  name: string,
  schema: z.ZodType,
  execute: (
    input: unknown,
    capabilities: ChannelActionCapabilities | ChannelQueryCapabilities,
  ) => Promise<unknown>,
): { readonly allowedOperations: typeof allowedOperations; readonly authorization: typeof authorization; readonly execute: typeof execute; readonly inputSchema: z.ZodType; readonly name: string } =>
  Object.defineProperties(
    { allowedOperations, authorization, execute, name },
    {
      inputSchema: {
        enumerable: true,
        get: () => snapshotSchema(schema),
      },
    },
  ) as { readonly allowedOperations: typeof allowedOperations; readonly authorization: typeof authorization; readonly execute: typeof execute; readonly inputSchema: z.ZodType; readonly name: string };

export const channelTypeDefinitionSchema = z.object({
  actions: z.array(channelContractSchema),
  activityFor: z.custom<(changes: readonly DomainChange[]) => string | undefined>(
    (value) => typeof value === 'function',
  ),
  activityKinds: z.array(z.string()),
  id: z.string().min(1),
  planTableFieldConversion: z.custom<(
    input: TableFieldConversionInput,
    state: ChannelTypeStatePort,
    sealCanonicalPlan: SealTableFieldConversionPlan,
  ) => Promise<TrustedTableFieldConversionPlan>>(
    (value) => value === undefined || typeof value === 'function',
  ).optional(),
  queries: z.array(channelContractSchema),
  recordKinds: z.array(z.enum(['dictionary-entry', 'discussion-message', 'table-record'])),
  stateRules: z.array(channelStateRuleSchema),
  title: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  views: z.array(z.object({
    bindings: z.record(z.string(), z.string()),
    commandRoles: z.record(z.string(), z.enum(['viewer', 'contributor', 'admin', 'owner'])).optional(),
    commands: z.array(z.string()),
    kind: z.string().min(1),
    produce: z.custom<(input: ChannelViewInput, declaration: ChannelViewDeclaration) => ViewDefinition>(
      (value) => value === undefined || typeof value === 'function',
    ).optional(),
    query: z.string().min(1),
    title: z.union([
      z.string().min(1),
      z.custom<(input: ChannelViewInput) => string>((value) => typeof value === 'function'),
    ]),
  })),
});

export type ChannelTypeDefinition = z.infer<typeof channelTypeDefinitionSchema>;

export const bundledChannelTypes: readonly ChannelTypeDefinition[] = [
  tableChannelType,
  dictionaryChannelType,
  chartChannelType,
];

export class ChannelTypeRegistry {
  readonly #conversionPlanIssuers = new Map<string, WeakSet<object>>();
  readonly #definitions = new Map<string, ChannelTypeDefinition>();
  readonly #handlers = new Map<string, (
    input: unknown,
    capabilities: ChannelActionCapabilities | ChannelQueryCapabilities,
  ) => Promise<unknown>>();
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
          this.#handlers.set(
            `action:${ChannelTypeRegistry.key(parsed.id, parsed.version)}:${contract.name}`,
            contract.execute,
          );
          return publicContract(contract.allowedOperations, contract.authorization, contract.name, schema, contract.execute);
        }),
        queries: parsed.queries.map((contract) => {
          const schema = snapshotSchema(contract.inputSchema);
          this.#schemas.set(
            `query:${ChannelTypeRegistry.key(parsed.id, parsed.version)}:${contract.name}`,
            schema,
          );
          this.#handlers.set(
            `query:${ChannelTypeRegistry.key(parsed.id, parsed.version)}:${contract.name}`,
            contract.execute,
          );
          return publicContract(contract.allowedOperations, contract.authorization, contract.name, schema, contract.execute);
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
      this.#conversionPlanIssuers.set(key, new WeakSet());
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

  async planTableFieldConversion(
    id: string,
    version: string,
    binding: Omit<TrustedTableFieldConversionPlan['binding'], 'fieldId' | 'observedVersion'>,
    input: TableFieldConversionInput,
    state: ChannelTypeStatePort,
  ): Promise<TrustedTableFieldConversionPlan> {
    const definition = this.require(id, version);
    invariant(definition.planTableFieldConversion, 'channel-type.capability-denied', 'Selected Channel Type version does not own Field conversion planning', 403);
    const key = ChannelTypeRegistry.key(id, version);
    const issuer = this.#conversionPlanIssuers.get(key)!;
    const seal: SealTableFieldConversionPlan = (payload, fieldId, observedVersion) => {
      const sealed = deepFreeze(structuredClone({
        ...payload,
        binding: { ...binding, fieldId, observedVersion },
      })) as TrustedTableFieldConversionPlan;
      issuer.add(sealed);
      return sealed;
    };
    return definition.planTableFieldConversion(input, state, seal);
  }

  consumeTableFieldConversionPlan(
    id: string,
    version: string,
    value: TrustedTableFieldConversionPlan,
    binding: Omit<TrustedTableFieldConversionPlan['binding'], 'fieldId' | 'observedVersion'>,
  ): TrustedTableFieldConversionPlan {
    const issuer = this.#conversionPlanIssuers.get(ChannelTypeRegistry.key(id, version));
    invariant(value !== null && typeof value === 'object' && issuer?.delete(value), 'channel-type.capability-denied', 'Field conversion plan was not issued by the selected Channel Type version', 403);
    invariant(value.purpose === 'execute', 'channel-type.capability-denied', 'Preview plans cannot emit Field transitions', 403);
    invariant(
      value.binding.actorId === binding.actorId &&
        value.binding.channelId === binding.channelId &&
        value.binding.serviceId === binding.serviceId,
      'channel-type.capability-denied',
      'Field conversion plan belongs to another execution scope',
      403,
    );
    return value;
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

  async executeAction<T>(
    id: string,
    version: string,
    name: string,
    input: unknown,
    capabilities: ChannelActionCapabilities,
  ): Promise<T> {
    const schema = this.requireAction(id, version, name);
    if (!schema) throw new DatagramError('channel-type.action-undeclared', `Channel Type Action is not declared: ${name}`);
    const parsed = deepFreeze(schema.parse(input));
    this.validateState(id, version, name, parsed);
    const handler = this.#handlers.get(
      `action:${ChannelTypeRegistry.key(id, version)}:${name}`,
    );
    return handler!(parsed, capabilities) as Promise<T>;
  }

  async executeQuery<T>(
    id: string,
    version: string,
    name: string,
    input: unknown,
    capabilities: ChannelQueryCapabilities,
  ): Promise<T> {
    const schema = this.requireQuery(id, version, name);
    if (!schema) throw new DatagramError('channel-type.query-undeclared', `Channel Type Query is not declared: ${name}`);
    const parsed = deepFreeze(schema.parse(input));
    this.validateState(id, version, name, parsed);
    const handler = this.#handlers.get(
      `query:${ChannelTypeRegistry.key(id, version)}:${name}`,
    );
    return handler!(parsed, capabilities) as Promise<T>;
  }

  requireAuthorization(id: string, version: string, kind: 'action' | 'query', name: string) {
    const contracts = kind === 'action' ? this.require(id, version).actions : this.require(id, version).queries;
    return contracts.find((candidate) => candidate.name === name)?.authorization;
  }

  requireAllowedOperations(id: string, version: string, name: string) {
    return this.require(id, version).actions.find((candidate) => candidate.name === name)?.allowedOperations ?? [];
  }

  activityFor(id: string, version: string, changes: readonly DomainChange[]): string | undefined {
    return this.require(id, version).activityFor(changes);
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
    input: ChannelViewInput,
  ): ViewDefinition {
    const definition = this.require(id, version);
    const declared = definition.views.find((candidate) => candidate.query === query);
    if (!declared) {
      throw new DatagramError(
        'channel-type.view-undeclared',
        `Channel Type Query has no View Definition: ${id}@${version}:${query}`,
      );
    }
    const declaration: ChannelViewDeclaration = {
      bindings: declared.bindings,
      commands: declared.commands,
      kind: declared.kind,
      title: declared.title,
      ...(declared.commandRoles === undefined ? {} : { commandRoles: declared.commandRoles }),
    };
    const view = viewDefinitionSchema.parse(declared.produce?.(input, declaration));
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
