import * as z from 'zod/v4';

import { DatagramError } from '../domain/errors';
import type { ActionReceipt, OperationOrigin, QueryResult } from '../domain/model';

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

class DefinitionRegistry<TDefinition extends { inputSchema: z.ZodType; name: string }> {
  readonly #definitions = new Map<string, TDefinition>();

  constructor(definitions: readonly TDefinition[], duplicateCode: string) {
    for (const definition of definitions) {
      if (this.#definitions.has(definition.name)) {
        throw new DatagramError(duplicateCode, `Duplicate definition: ${definition.name}`);
      }
      this.#definitions.set(definition.name, Object.freeze(definition));
    }
  }

  list(): readonly TDefinition[] {
    return [...this.#definitions.values()];
  }

  require(name: string, missingCode: string): TDefinition {
    const definition = this.#definitions.get(name);
    if (!definition) throw new DatagramError(missingCode, `Unknown definition: ${name}`, 404);
    return definition;
  }
}

export class ActionRegistry {
  readonly #registry: DefinitionRegistry<ActionDefinition>;

  constructor(definitions: readonly ActionDefinition[]) {
    this.#registry = new DefinitionRegistry(definitions, 'action.duplicate');
  }

  list(): readonly ActionDefinition[] {
    return this.#registry.list();
  }

  async execute(
    name: string,
    context: ExecutionContext,
    rawInput: unknown,
  ): Promise<ActionReceipt> {
    const definition = this.#registry.require(name, 'action.unknown');
    return definition.run(context, definition.inputSchema.parse(rawInput));
  }
}

export class QueryRegistry {
  readonly #registry: DefinitionRegistry<QueryDefinition>;

  constructor(definitions: readonly QueryDefinition[]) {
    this.#registry = new DefinitionRegistry(definitions, 'query.duplicate');
  }

  list(): readonly QueryDefinition[] {
    return this.#registry.list();
  }

  async execute(
    name: string,
    context: ExecutionContext,
    rawInput: unknown,
  ): Promise<QueryResult> {
    const definition = this.#registry.require(name, 'query.unknown');
    return definition.run(context, definition.inputSchema.parse(rawInput));
  }
}
