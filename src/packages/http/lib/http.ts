import { ZodError } from 'zod';

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

      return json({ error: { code: 'route.not-found', message: 'Route not found' } }, 404);
    } catch (error) {
      return failure(error);
    }
  };
}
