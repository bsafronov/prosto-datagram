import * as z from 'zod/v4';

import { DatagramError } from '../../domain/errors';
import type { JsonValue, QueryResult, ViewDefinition } from '../../domain/model';
import { newId } from '../../domain/model';

export type AgentViewMetadata = Readonly<Pick<
  ViewDefinition,
  'bindings' | 'commands' | 'kind' | 'schemaVersion'
>>;

export interface ResultSourceAuthorization {
  readonly input: unknown;
  readonly queryName: string;
}

interface HandleEntry {
  readonly actorId: string;
  readonly evaluate: () => Promise<QueryResult>;
  readonly expiresAt: number;
  readonly purpose: string;
  readonly serviceId: string;
  readonly sources: readonly ResultSourceAuthorization[];
  readonly view: AgentViewMetadata;
}

export interface IssuedResultHandle {
  readonly expiresAt: string;
  readonly id: string;
  readonly purpose: string;
  readonly view: AgentViewMetadata;
}

export type ResultFilterOperator =
  | 'contains'
  | 'equals'
  | 'greater-than'
  | 'is-empty'
  | 'less-than';

export interface ResultFilter {
  readonly field: string;
  readonly operator: ResultFilterOperator;
  readonly value?: JsonValue | undefined;
}

export interface ResultAggregation {
  readonly as: string;
  readonly field?: string | undefined;
  readonly operator: 'average' | 'count' | 'maximum' | 'minimum' | 'sum';
}

export type ResultHandleTransform =
  | { readonly filters: readonly ResultFilter[]; readonly kind: 'filter' }
  | { readonly fields: readonly string[]; readonly kind: 'group' }
  | { readonly aggregations: readonly ResultAggregation[]; readonly kind: 'aggregate' }
  | { readonly kind: 'pass' };

export interface ResultHandleComposition {
  readonly handleId: string;
  readonly inputPurpose: string;
  readonly outputPurpose: string;
  readonly transform: ResultHandleTransform;
}

export interface DataViewQueryDefinition {
  readonly input: unknown;
  readonly purpose: string;
  readonly queryName: string;
}

export interface ResultHandleBrokerOptions {
  readonly clock?: () => number;
  readonly serviceId?: string;
  readonly ttlMilliseconds?: number;
}

const resultFilterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['contains', 'equals', 'greater-than', 'is-empty', 'less-than']),
  value: z.json().optional(),
});

const resultAggregationSchema = z.object({
  as: z.string().min(1),
  field: z.string().min(1).optional(),
  operator: z.enum(['average', 'count', 'maximum', 'minimum', 'sum']),
});

export const resultHandleCompositionSchema: z.ZodType<ResultHandleComposition> = z.object({
  handleId: z.string().min(1),
  inputPurpose: z.string().min(1),
  outputPurpose: z.string().min(1),
  transform: z.discriminatedUnion('kind', [
    z.object({ filters: z.array(resultFilterSchema), kind: z.literal('filter') }),
    z.object({ fields: z.array(z.string().min(1)).min(1), kind: z.literal('group') }),
    z.object({
      aggregations: z.array(resultAggregationSchema).min(1),
      kind: z.literal('aggregate'),
    }),
    z.object({ kind: z.literal('pass') }),
  ]),
});

export function sanitizeViewForAgent(view: ViewDefinition): AgentViewMetadata {
  return {
    bindings: { ...view.bindings },
    commands: [...view.commands],
    kind: view.kind,
    schemaVersion: view.schemaVersion,
  };
}

const recordValue = (row: JsonValue, field: string): JsonValue | undefined => {
  if (row === null || Array.isArray(row) || typeof row !== 'object') return undefined;
  const direct = row[field];
  if (direct !== undefined) return direct;
  const values = row.values;
  return values !== null && !Array.isArray(values) && typeof values === 'object'
    ? values[field]
    : undefined;
};

const comparable = (value: JsonValue | undefined): number | string | undefined =>
  typeof value === 'number' || typeof value === 'string' ? value : undefined;

const matches = (row: JsonValue, filter: ResultFilter): boolean => {
  const actual = recordValue(row, filter.field);
  switch (filter.operator) {
    case 'contains':
      return typeof actual === 'string' &&
        typeof filter.value === 'string' &&
        actual.includes(filter.value);
    case 'equals':
      return JSON.stringify(actual) === JSON.stringify(filter.value);
    case 'greater-than': {
      const left = comparable(actual);
      const right = comparable(filter.value);
      return left !== undefined && right !== undefined && typeof left === typeof right && left > right;
    }
    case 'is-empty':
      return actual === undefined || actual === null || actual === '';
    case 'less-than': {
      const left = comparable(actual);
      const right = comparable(filter.value);
      return left !== undefined && right !== undefined && typeof left === typeof right && left < right;
    }
  }
};

interface ResultGroup {
  readonly key: Readonly<Record<string, JsonValue>>;
  readonly rows: readonly JsonValue[];
}

const isResultGroup = (value: JsonValue): value is ResultGroup & JsonValue =>
  value !== null &&
  !Array.isArray(value) &&
  typeof value === 'object' &&
  Array.isArray(value.rows) &&
  value.key !== null &&
  !Array.isArray(value.key) &&
  typeof value.key === 'object';

const rowsFrom = (data: JsonValue): readonly JsonValue[] => (Array.isArray(data) ? data : [data]);

const groupRows = (rows: readonly JsonValue[], fields: readonly string[]): JsonValue => {
  const groups = new Map<string, { key: Record<string, JsonValue>; rows: JsonValue[] }>();
  for (const row of rows) {
    const key = Object.fromEntries(
      fields.map((field) => [field, recordValue(row, field) ?? null]),
    ) as Record<string, JsonValue>;
    const serialized = JSON.stringify(key);
    const group = groups.get(serialized) ?? { key, rows: [] };
    group.rows.push(row);
    groups.set(serialized, group);
  }
  return [...groups.values()];
};

const aggregateRows = (
  rows: readonly JsonValue[],
  aggregations: readonly ResultAggregation[],
): Readonly<Record<string, JsonValue>> =>
  Object.fromEntries(
    aggregations.map((aggregation) => {
      if (aggregation.operator === 'count') return [aggregation.as, rows.length];
      const values = rows
        .map((row) =>
          aggregation.field === undefined ? undefined : recordValue(row, aggregation.field),
        )
        .filter((value): value is number => typeof value === 'number');
      if (values.length === 0) return [aggregation.as, null];
      switch (aggregation.operator) {
        case 'average':
          return [aggregation.as, values.reduce((sum, value) => sum + value, 0) / values.length];
        case 'maximum':
          return [aggregation.as, Math.max(...values)];
        case 'minimum':
          return [aggregation.as, Math.min(...values)];
        case 'sum':
          return [aggregation.as, values.reduce((sum, value) => sum + value, 0)];
      }
    }),
  );

export function transformResult(result: QueryResult, transform: ResultHandleTransform): QueryResult {
  let data: JsonValue;
  switch (transform.kind) {
    case 'filter':
      data = rowsFrom(result.data).filter((row) =>
        transform.filters.every((filter) => matches(row, filter)),
      );
      break;
    case 'group':
      data = groupRows(rowsFrom(result.data), transform.fields);
      break;
    case 'aggregate': {
      const rows = rowsFrom(result.data);
      data = rows.every(isResultGroup)
        ? rows.map((group) => ({
            ...group.key,
            ...aggregateRows(group.rows, transform.aggregations),
          }))
        : aggregateRows(rows, transform.aggregations);
      break;
    }
    case 'pass':
      data = result.data;
      break;
  }
  return { data, view: result.view };
}

export class ResultHandleBroker {
  readonly #clock: () => number;
  readonly #entries = new Map<string, HandleEntry>();
  readonly serviceId: string;
  readonly ttlMilliseconds: number;

  constructor(options: ResultHandleBrokerOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.serviceId = options.serviceId ?? newId('service');
    this.ttlMilliseconds = options.ttlMilliseconds ?? 5 * 60 * 1000;
  }

  issue(
    actorId: string,
    purpose: string,
    source: ResultSourceAuthorization,
    result: QueryResult,
    evaluate: () => Promise<QueryResult>,
  ): IssuedResultHandle {
    return this.#issue({
      actorId,
      evaluate,
      expiresAt: this.#clock() + this.ttlMilliseconds,
      purpose,
      serviceId: this.serviceId,
      sources: [source],
      view: sanitizeViewForAgent(result.view),
    });
  }

  async compose(
    serviceId: string,
    actorId: string,
    composition: ResultHandleComposition,
  ): Promise<IssuedResultHandle> {
    const source = this.#require(
      serviceId,
      actorId,
      composition.handleId,
      composition.inputPurpose,
    );
    await this.consume(
      serviceId,
      actorId,
      composition.handleId,
      composition.inputPurpose,
    );
    return this.#issue({
      actorId,
      evaluate: async () =>
        transformResult(
          await this.consume(
            serviceId,
            actorId,
            composition.handleId,
            composition.inputPurpose,
          ),
          composition.transform,
        ),
      expiresAt: Math.min(source.expiresAt, this.#clock() + this.ttlMilliseconds),
      purpose: composition.outputPurpose,
      serviceId,
      sources: source.sources,
      view: source.view,
    });
  }

  async consume(
    serviceId: string,
    actorId: string,
    handleId: string,
    purpose: string,
  ): Promise<QueryResult> {
    const entry = this.#require(serviceId, actorId, handleId, purpose);
    try {
      return await entry.evaluate();
    } catch {
      throw new DatagramError(
        'result-handle.source-unavailable',
        'Result Handle source authorization is no longer valid',
        403,
      );
    }
  }

  #issue(entry: HandleEntry): IssuedResultHandle {
    const id = newId('result');
    this.#entries.set(id, entry);
    return {
      expiresAt: new Date(entry.expiresAt).toISOString(),
      id,
      purpose: entry.purpose,
      view: entry.view,
    };
  }

  #require(
    serviceId: string,
    actorId: string,
    handleId: string,
    purpose: string,
  ): HandleEntry {
    const entry = this.#entries.get(handleId);
    if (!entry || entry.expiresAt <= this.#clock()) {
      this.#entries.delete(handleId);
      throw new DatagramError('result-handle.expired', 'Result Handle is missing or expired', 404);
    }
    if (entry.serviceId !== serviceId) {
      throw new DatagramError(
        'result-handle.service-mismatch',
        'Result Handle belongs to another Service',
        403,
      );
    }
    if (entry.actorId !== actorId) {
      throw new DatagramError(
        'result-handle.actor-mismatch',
        'Result Handle belongs to another actor',
        403,
      );
    }
    if (entry.purpose !== purpose) {
      throw new DatagramError(
        'result-handle.purpose-mismatch',
        'Result Handle has another declared purpose',
        403,
      );
    }
    return entry;
  }
}
