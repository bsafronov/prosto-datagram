import * as z from 'zod/v4';

import { DatagramError } from '../../domain/errors';
import {
  viewDefinitionSchema,
  type ActionReceipt,
  type OperationOrigin,
  type QueryResult,
} from '../../domain/model';

export interface ExecutionContext {
  readonly actorId: string;
  readonly origin: OperationOrigin;
}

export interface ActionDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly name: string;
  readonly run: (context: ExecutionContext, input: unknown) => Promise<ActionReceipt>;
}

export interface QueryDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly name: string;
  readonly run: (context: ExecutionContext, input: unknown) => Promise<QueryResult>;
}

export interface ContractDefinition {
  readonly description: string;
  readonly inputSchema: z.core.JSONSchema.BaseSchema;
  readonly name: string;
}

export interface ChannelTypeContractSelector {
  readonly typeId: string;
  readonly typeVersion: string;
}

type ContractSchemaResolver = (
  selector: ChannelTypeContractSelector,
  name: string,
) => z.ZodType | undefined;

export const defineAction = <TInput>(definition: {
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly name: string;
  readonly run: (context: ExecutionContext, input: TInput) => Promise<ActionReceipt>;
}): ActionDefinition => ({
  ...definition,
  run: (context, input) => definition.run(context, input as TInput),
});

export const defineQuery = <TInput>(definition: {
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly name: string;
  readonly run: (context: ExecutionContext, input: TInput) => Promise<QueryResult>;
}): QueryDefinition => ({
  ...definition,
  run: (context, input) => definition.run(context, input as TInput),
});

class DefinitionRegistry<
  TDefinition extends { description: string; inputSchema: z.ZodType; name: string },
> {
  readonly #definitions = new Map<string, TDefinition>();

  constructor(definitions: readonly TDefinition[], duplicateCode: string) {
    for (const definition of definitions) {
      if (this.#definitions.has(definition.name)) {
        throw new DatagramError(duplicateCode, `Duplicate definition: ${definition.name}`);
      }
      this.#definitions.set(definition.name, Object.freeze(definition));
    }
  }

  list(resolveSchema?: (name: string) => z.ZodType | null | undefined): readonly TDefinition[] {
    return [...this.#definitions.values()].flatMap((definition) => {
      const inputSchema = resolveSchema?.(definition.name);
      if (inputSchema === null) return [];
      return inputSchema === undefined ? [definition] : [{ ...definition, inputSchema }];
    });
  }

  catalog(
    resolveSchema?: (name: string) => z.ZodType | null | undefined,
  ): readonly ContractDefinition[] {
    return this.list(resolveSchema).map(({ description, inputSchema, name }) => ({
      description,
      inputSchema: z.toJSONSchema(inputSchema, { unrepresentable: 'any' }),
      name,
    }));
  }

  require(name: string, missingCode: string): TDefinition {
    const definition = this.#definitions.get(name);
    if (!definition) throw new DatagramError(missingCode, `Unknown definition: ${name}`, 404);
    return definition;
  }
}

export class ActionRegistry {
  readonly #registry: DefinitionRegistry<ActionDefinition>;
  readonly #schemaResolver: ContractSchemaResolver | undefined;
  readonly #channelContractNames: ReadonlySet<string>;

  constructor(
    definitions: readonly ActionDefinition[],
    schemaResolver?: ContractSchemaResolver,
    channelContractNames: ReadonlySet<string> = new Set(),
  ) {
    this.#registry = new DefinitionRegistry(definitions, 'action.duplicate');
    this.#schemaResolver = schemaResolver;
    this.#channelContractNames = channelContractNames;
  }

  list(selector?: ChannelTypeContractSelector): readonly ActionDefinition[] {
    return this.#registry.list(this.#selectedSchemaResolver(selector));
  }

  catalog(selector?: ChannelTypeContractSelector): readonly ContractDefinition[] {
    return this.#registry.catalog(this.#selectedSchemaResolver(selector));
  }

  #selectedSchemaResolver(
    selector?: ChannelTypeContractSelector,
  ): ((name: string) => z.ZodType | null | undefined) | undefined {
    if (!selector || !this.#schemaResolver) return undefined;
    return (name) =>
      this.#schemaResolver!(selector, name) ??
      (this.#channelContractNames.has(name) ? null : undefined);
  }

  async execute(
    name: string,
    context: ExecutionContext,
    rawInput: unknown,
    inputSchema?: z.ZodType,
  ): Promise<ActionReceipt> {
    const definition = this.#registry.require(name, 'action.unknown');
    return definition.run(context, (inputSchema ?? definition.inputSchema).parse(rawInput));
  }
}

export class QueryRegistry {
  readonly #registry: DefinitionRegistry<QueryDefinition>;
  readonly #schemaResolver: ContractSchemaResolver | undefined;
  readonly #channelContractNames: ReadonlySet<string>;

  constructor(
    definitions: readonly QueryDefinition[],
    schemaResolver?: ContractSchemaResolver,
    channelContractNames: ReadonlySet<string> = new Set(),
  ) {
    this.#registry = new DefinitionRegistry(definitions, 'query.duplicate');
    this.#schemaResolver = schemaResolver;
    this.#channelContractNames = channelContractNames;
  }

  list(selector?: ChannelTypeContractSelector): readonly QueryDefinition[] {
    return this.#registry.list(this.#selectedSchemaResolver(selector));
  }

  catalog(selector?: ChannelTypeContractSelector): readonly ContractDefinition[] {
    return this.#registry.catalog(this.#selectedSchemaResolver(selector));
  }

  #selectedSchemaResolver(
    selector?: ChannelTypeContractSelector,
  ): ((name: string) => z.ZodType | null | undefined) | undefined {
    if (!selector || !this.#schemaResolver) return undefined;
    return (name) =>
      this.#schemaResolver!(selector, name) ??
      (this.#channelContractNames.has(name) ? null : undefined);
  }

  async execute(
    name: string,
    context: ExecutionContext,
    rawInput: unknown,
    inputSchema?: z.ZodType,
  ): Promise<QueryResult> {
    const definition = this.#registry.require(name, 'query.unknown');
    const result = await definition.run(
      context,
      (inputSchema ?? definition.inputSchema).parse(rawInput),
    );
    return { ...result, view: viewDefinitionSchema.parse(result.view) };
  }
}
