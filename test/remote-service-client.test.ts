import { expect, test } from 'bun:test';

import { createRemoteServiceApplication } from '../src/packages/remote-service-client';

test('remote Service client preserves canonical catalog schemas and validates inputs', async () => {
  const inputSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { title: { type: 'string', minLength: 1 } },
    required: ['title'],
    additionalProperties: false,
  };
  const requested: string[] = [];
  const app = await createRemoteServiceApplication({
    baseUrl: new URL('https://datagram.example/'),
    bearerToken: 'secret',
    request: (request) => {
      requested.push(new URL(request.url).pathname);
      if (request.url.endsWith('/v1/actions')) {
        return Promise.resolve(
          Response.json({ actions: [{ name: 'channel.create', description: 'Create', inputSchema }] }),
        );
      }
      return Promise.resolve(
        Response.json({ queries: [{ name: 'channel.list', description: 'List', inputSchema }] }),
      );
    },
  });

  expect(JSON.stringify(app.actions.catalog()[0]?.inputSchema)).toBe(JSON.stringify(inputSchema));
  expect(JSON.stringify(app.queries.catalog()[0]?.inputSchema)).toBe(JSON.stringify(inputSchema));
  expect(() => app.actions.list()[0]?.inputSchema.parse({})).toThrow();
  expect(requested.sort()).toEqual(['/v1/actions', '/v1/queries']);
});
