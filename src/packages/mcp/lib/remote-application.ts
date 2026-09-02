import * as z from 'zod/v4';

import type { IssuedResultHandle, ResultHandleComposition } from '../../application';
import {
  ActionRegistry,
  QueryRegistry,
  type ChannelTypeContractSelector,
} from '../../application/contracts';
import { DatagramError } from '../../application/errors';
import type { ActionReceipt, OperationOrigin } from '../../domain/model';
import type { McpApplicationPort } from './gateway';

interface CatalogDefinition {
  readonly description: string;
  readonly name: string;
}

interface RemoteApplicationOptions {
  readonly baseUrl: URL;
  readonly bearerToken: string;
  readonly request: (request: Request) => Promise<Response>;
}

function selectedPath(path: string, selectedType?: ChannelTypeContractSelector): string {
  if (selectedType === undefined) return path;
  const query = new URLSearchParams({
    typeId: selectedType.typeId,
    typeVersion: selectedType.typeVersion,
  });
  return `${path}?${query.toString()}`;
}

function definitions(value: unknown, key: 'actions' | 'queries'): readonly CatalogDefinition[] {
  if (typeof value !== 'object' || value === null || !(key in value)) return [];
  const candidates = (value as Record<string, unknown>)[key];
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) =>
    typeof candidate === 'object' &&
    candidate !== null &&
    'name' in candidate &&
    typeof candidate.name === 'string' &&
    'description' in candidate &&
    typeof candidate.description === 'string'
      ? [{ name: candidate.name, description: candidate.description }]
      : [],
  );
}

export async function createRemoteMcpApplication({
  baseUrl,
  bearerToken,
  request,
}: RemoteApplicationOptions): Promise<McpApplicationPort> {
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(
        new Request(new URL(path, baseUrl), {
          ...init,
          headers: { authorization: `Bearer ${bearerToken}`, ...init?.headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        }),
      );
    } catch {
      throw new DatagramError('mcp.service-unavailable', 'Datagram Service is unavailable.', 503);
    }
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        typeof value === 'object' &&
        value !== null &&
        'error' in value &&
        typeof value.error === 'object' &&
        value.error !== null &&
        'code' in value.error &&
        typeof value.error.code === 'string'
          ? value.error.code
          : 'mcp.service-failed';
      throw new DatagramError(code, 'Datagram Service request failed.', response.status);
    }
    return value;
  };

  const [actionCatalog, queryCatalog] = await Promise.all([
    call('/v1/actions'),
    call('/v1/queries'),
  ]);
  const actions = new ActionRegistry(
    definitions(actionCatalog, 'actions').map((definition) => ({
      ...definition,
      inputSchema: z.any(),
      run: async () => {
        throw new Error('Remote Actions execute through HTTP');
      },
    })),
  );
  const queries = new QueryRegistry(
    definitions(queryCatalog, 'queries').map((definition) => ({
      ...definition,
      inputSchema: z.any(),
      run: async () => {
        throw new Error('Remote Queries execute through HTTP');
      },
    })),
  );

  return {
    actions,
    queries,
    verifyServiceIdentity: async (actorId) => ({ actorId }),
    executeAction: async (
      _actorId: string,
      _origin: OperationOrigin,
      name: string,
      input: unknown,
      selectedType?: ChannelTypeContractSelector,
    ) =>
      (await call(selectedPath(`/v1/actions/${encodeURIComponent(name)}`, selectedType), {
        body: JSON.stringify(input),
        method: 'POST',
      })) as ActionReceipt,
    prepareQuery: async (
      _actorId: string,
      _origin: OperationOrigin,
      name: string,
      input: unknown,
      _purpose?: string,
      selectedType?: ChannelTypeContractSelector,
    ) =>
      (await call(selectedPath(`/v1/agent/queries/${encodeURIComponent(name)}`, selectedType), {
        body: JSON.stringify(input),
        method: 'POST',
      })) as IssuedResultHandle,
    composeResultHandle: async (_actorId: string, composition: ResultHandleComposition) =>
      (await call('/v1/agent/result-handles/compose', {
        body: JSON.stringify(composition),
        method: 'POST',
      })) as IssuedResultHandle,
  };
}
