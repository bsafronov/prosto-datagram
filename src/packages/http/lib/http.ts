import { resultHandleCompositionSchema } from '../../application';
import type { ChannelTypeContractSelector } from '../../application/contracts';
import { DatagramError, toPublicError } from '../../application/errors';
import type { DatagramApplicationPort } from '../../application/port';

export interface HttpHandlerOptions {
  readonly app: DatagramApplicationPort;
  readonly verifyIdentity: HttpIdentityVerifier;
}

export interface DevelopmentHttpHandlerOptions {
  readonly app: DatagramApplicationPort;
  readonly defaultActorId: string;
}

export interface VerifiedServiceIdentity {
  readonly actorId: string;
}

export type HttpIdentityVerifier = (
  request: Request,
) => Promise<VerifiedServiceIdentity | undefined> | VerifiedServiceIdentity | undefined;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: { 'cache-control': 'no-store' },
    status,
  });
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DatagramError('json.invalid', 'Invalid JSON input', 400);
  }
}

function failure(error: unknown): Response {
  const result = toPublicError(error);
  return json(result.body, result.status);
}

function channelTypeSelector(url: URL): ChannelTypeContractSelector | undefined {
  const typeId = url.searchParams.get('typeId');
  const typeVersion = url.searchParams.get('typeVersion');
  if ((typeId === null) !== (typeVersion === null)) {
    throw new DatagramError(
      'input.invalid',
      'typeId and typeVersion must be provided together',
      400,
    );
  }
  return typeId === null || typeVersion === null ? undefined : { typeId, typeVersion };
}

function eventStream(
  app: DatagramApplicationPort,
  actorId: string,
  after: number,
  requestSignal: AbortSignal,
): Response {
  const abort = new AbortController();
  const iterator = app.subscribe(actorId, { after, signal: abort.signal })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  requestSignal.addEventListener('abort', () => abort.abort(), { once: true });
  return new Response(
    new ReadableStream<Uint8Array>({
      async cancel() {
        abort.abort();
        await iterator.return?.();
      },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              `id: ${next.value.position}\nevent: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`,
            ),
          );
        } catch (error) {
          controller.error(error);
        }
      },
    }),
    {
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    },
  );
}

function handler(
  app: DatagramApplicationPort,
  identityMode: 'development' | 'production',
  verifyIdentity: HttpIdentityVerifier,
) {
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok' });
      }
      const identity = await verifyIdentity(request);
      if (!identity) {
        throw new DatagramError('identity.unauthenticated', 'Authentication required', 401);
      }
      const actorId = identity.actorId;
      const selector = channelTypeSelector(url);
      if (request.method === 'GET' && url.pathname === '/v1/actions') {
        return json({ actions: app.actions.catalog(selector) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/queries') {
        return json({ queries: app.queries.catalog(selector) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        const rawPosition =
          request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? '0';
        const after = Number(rawPosition);
        if (!Number.isSafeInteger(after) || after < 0) {
          return json(
            {
              error: {
                code: 'subscription.position-invalid',
                message: 'Subscription position must be a non-negative integer',
              },
            },
            400,
          );
        }
        return eventStream(app, actorId, after, request.signal);
      }

      const action = url.pathname.match(/^\/v1\/actions\/([^/]+)$/);
      if (request.method === 'POST' && action?.[1]) {
        const name = decodeURIComponent(action[1]);
        if (selector && !app.actions.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('action.unknown', `Unknown definition: ${name}`, 404);
        }
        return json(
          await app.executeAction(actorId, 'http', name, await body(request)),
          201,
        );
      }

      const query = url.pathname.match(/^\/v1\/queries\/([^/]+)$/);
      if (request.method === 'POST' && query?.[1]) {
        const name = decodeURIComponent(query[1]);
        if (selector && !app.queries.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('query.unknown', `Unknown definition: ${name}`, 404);
        }
        return json(
          await app.executeQuery(actorId, 'http', name, await body(request)),
        );
      }

      const agentQuery = url.pathname.match(/^\/v1\/agent\/queries\/([^/]+)$/);
      if (request.method === 'POST' && agentQuery?.[1]) {
        const name = decodeURIComponent(agentQuery[1]);
        if (selector && !app.queries.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('query.unknown', `Unknown definition: ${name}`, 404);
        }
        return json(
          await app.prepareQuery(
            actorId,
            'agent',
            name,
            await body(request),
          ),
          201,
        );
      }

      if (request.method === 'POST' && url.pathname === '/v1/agent/result-handles/compose') {
        return json(
          await app.composeResultHandle(
            actorId,
            resultHandleCompositionSchema.parse(await body(request)),
          ),
          201,
        );
      }

      const resultHandle = url.pathname.match(/^\/v1\/result-handles\/([^/]+)$/);
      if (request.method === 'POST' && resultHandle?.[1]) {
        const input = (await body(request)) as { purpose?: unknown };
        if (typeof input.purpose !== 'string' || input.purpose.length === 0) {
          return json(
            { error: { code: 'input.invalid', message: 'Invalid input' } },
            400,
          );
        }
        return json(
          await app.consumeResultHandle(
            actorId,
            decodeURIComponent(resultHandle[1]),
            input.purpose,
          ),
        );
      }

      return json({ error: { code: 'route.not-found', message: 'Route not found' } }, 404);
    } catch (error) {
      return failure(error);
    }
  };

  return async (request: Request): Promise<Response> => {
    const response = await handle(request);
    response.headers.set('x-datagram-identity-mode', identityMode);
    return response;
  };
}

export function createHttpHandler({ app, verifyIdentity }: HttpHandlerOptions) {
  return handler(app, 'production', verifyIdentity);
}

export function createDevelopmentHttpHandler({
  app,
  defaultActorId,
}: DevelopmentHttpHandlerOptions) {
  return handler(app, 'development', (request) => ({
    actorId: request.headers.get('x-datagram-development-actor') ?? defaultActorId,
  }));
}
