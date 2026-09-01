import { ZodError } from 'zod';

import { resultHandleCompositionSchema } from '../../application';
import { DatagramError } from '../../application/errors';
import type { DatagramApplicationPort } from '../../application/port';

export interface HttpHandlerOptions {
  readonly app: DatagramApplicationPort;
  readonly defaultActorId: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: { 'cache-control': 'no-store' },
    status,
  });
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  return text === '' ? {} : JSON.parse(text);
}

function failure(error: unknown): Response {
  if (error instanceof DatagramError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof ZodError) {
    return json(
      { error: { code: 'input.invalid', issues: error.issues, message: 'Invalid input' } },
      400,
    );
  }
  if (error instanceof SyntaxError) {
    return json({ error: { code: 'json.invalid', message: 'Invalid JSON body' } }, 400);
  }
  return json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
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

export function createHttpHandler({ app, defaultActorId }: HttpHandlerOptions) {
  const catalog = (definitions: readonly { description: string; name: string }[]) =>
    definitions.map(({ description, name }) => ({ description, name }));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const actorId = request.headers.get('x-datagram-actor') ?? defaultActorId;

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname === '/v1/actions') {
        return json({ actions: catalog(app.actions.list()) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/queries') {
        return json({ queries: catalog(app.queries.list()) });
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
        return json(
          await app.executeAction(actorId, 'http', decodeURIComponent(action[1]), await body(request)),
          201,
        );
      }

      const query = url.pathname.match(/^\/v1\/queries\/([^/]+)$/);
      if (request.method === 'POST' && query?.[1]) {
        return json(
          await app.executeQuery(actorId, 'http', decodeURIComponent(query[1]), await body(request)),
        );
      }

      const agentQuery = url.pathname.match(/^\/v1\/agent\/queries\/([^/]+)$/);
      if (request.method === 'POST' && agentQuery?.[1]) {
        return json(
          await app.prepareQuery(
            actorId,
            'agent',
            decodeURIComponent(agentQuery[1]),
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
}
