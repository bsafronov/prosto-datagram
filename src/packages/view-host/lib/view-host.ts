import {
  viewDefinitionSchema,
  type JsonValue,
  type QueryResult,
} from '../../application/views';

const supportedKinds = new Set([
  'chart',
  'channel-list',
  'dictionary',
  'discussion',
  'table-records',
  'table-schema',
  'table-views',
]);

export interface RenderedView {
  readonly commands: readonly string[];
  readonly fallback: boolean;
  readonly kind: string;
  readonly semanticKind: string;
  readonly title: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

function resolveBinding(data: JsonValue, binding: string): JsonValue {
  let value = data;
  for (const segment of binding.split('.').slice(1)) {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, segment)
    ) {
      return null;
    }
    value = value[segment] ?? null;
  }
  return value;
}

export function renderView(result: QueryResult): RenderedView {
  const view = viewDefinitionSchema.parse(result.view);
  const fallback = !supportedKinds.has(view.kind);
  const values = Object.fromEntries(
    Object.entries(view.bindings).map(([name, binding]) => [
      name,
      resolveBinding(result.data, binding),
    ]),
  );
  return {
    commands: [...view.commands],
    fallback,
    kind: fallback ? 'generic' : view.kind,
    semanticKind: view.kind,
    title: view.title,
    values,
  };
}
