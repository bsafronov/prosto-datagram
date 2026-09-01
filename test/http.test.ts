import { afterEach, expect, test } from 'bun:test';

import { createDevelopmentHttpHandler, createHttpHandler } from '../src/packages/http';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

let runtime: DatagramRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

test('HTTP adapter exposes the shared action and query contracts', async () => {
  runtime = await createRuntime({ databasePath: ':memory:' });
  const fetch = createHttpHandler({
    app: runtime.app,
    verifyIdentity: (request) => {
      const authorization = request.headers.get('authorization');
      if (authorization === 'Bearer verified') return { actorId: runtime!.owner.id };
      if (authorization === 'Bearer unknown-service-identity') {
        return { actorId: 'person_missing' };
      }
      return undefined;
    },
  });
  const authenticated = (path: string, init?: RequestInit) =>
    new Request(`http://datagram.test${path}`, {
      ...init,
      headers: { authorization: 'Bearer verified', ...init?.headers },
    });

  const health = await fetch(new Request('http://datagram.test/health'));
  expect(await health.json()).toEqual({ status: 'ok' });

  const unauthenticated = await fetch(
    new Request('http://datagram.test/v1/actions', {
      headers: { 'x-datagram-development-actor': runtime.owner.id },
    }),
  );
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toEqual({
    error: { code: 'identity.unauthenticated', message: 'Authentication required' },
  });
  const unverifiedServiceIdentity = await fetch(
    new Request('http://datagram.test/v1/actions/channel.create', {
      body: JSON.stringify({ title: 'Rejected', typeId: 'table' }),
      headers: { authorization: 'Bearer unknown-service-identity' },
      method: 'POST',
    }),
  );
  expect(unverifiedServiceIdentity.status).toBe(404);
  expect(await unverifiedServiceIdentity.json()).toEqual({
    error: { code: 'person.not-found', message: 'Person does not exist' },
  });

  const invalidJson = await fetch(
    authenticated('/v1/actions/channel.create', {
      body: '{protected value',
      method: 'POST',
    }),
  );
  expect(invalidJson.status).toBe(400);
  expect(await invalidJson.json()).toEqual({
    error: { code: 'json.invalid', message: 'Invalid JSON input' },
  });

  const actions = await fetch(authenticated('/v1/actions'));
  expect(actions.headers.get('x-datagram-identity-mode')).toBe('production');
  expect(await actions.json()).toEqual({ actions: runtime.app.actions.catalog() });
  const queries = await fetch(authenticated('/v1/queries'));
  expect(await queries.json()).toEqual({ queries: runtime.app.queries.catalog() });
  const pinnedQueries = await fetch(
    authenticated('/v1/queries?typeId=table&typeVersion=1.0.0'),
  );
  expect(await pinnedQueries.json()).toEqual({
    queries: runtime.app.queries.catalog({ typeId: 'table', typeVersion: '1.0.0' }),
  });

  const created = await fetch(
    authenticated('/v1/actions/channel.create', {
      body: JSON.stringify({ title: 'Products', typeId: 'table' }),
      method: 'POST',
    }),
  );
  expect(created.status).toBe(201);
  const receipt = (await created.json()) as { subject: { id: string } };

  const queried = await fetch(
    authenticated('/v1/queries/channel.list', {
      body: '{}',
      method: 'POST',
    }),
  );
  const result = (await queried.json()) as { data: { id: string }[]; view: unknown };
  expect(result.data[0]?.id).toBe(receipt.subject.id);
  expect(result.view).toBeDefined();

  const prepared = await fetch(
    authenticated('/v1/agent/queries/channel.list', {
      body: '{}',
      method: 'POST',
    }),
  );
  const sourceHandle = (await prepared.json()) as { id: string; purpose: string };
  expect(JSON.stringify(sourceHandle)).not.toContain('Products');

  const composed = await fetch(
    authenticated('/v1/agent/result-handles/compose', {
      body: JSON.stringify({
        handleId: sourceHandle.id,
        inputPurpose: sourceHandle.purpose,
        outputPurpose: 'trusted.render',
        transform: {
          aggregations: [{ as: 'Derived count', operator: 'count' }],
          kind: 'aggregate',
        },
      }),
      method: 'POST',
    }),
  );
  expect(composed.status).toBe(201);
  const composedHandle = (await composed.json()) as { id: string };
  expect(JSON.stringify(composedHandle)).not.toContain('Products');
  expect(JSON.stringify(composedHandle)).not.toContain('Derived count');

  const rendered = await fetch(
    authenticated(`/v1/result-handles/${composedHandle.id}`, {
      body: JSON.stringify({ purpose: 'trusted.render' }),
      method: 'POST',
    }),
  );
  expect((await rendered.json()) as { data: unknown }).toMatchObject({
    data: { 'Derived count': 1 },
  });
});

test('development HTTP actor selection is explicit and separate from production identity', async () => {
  runtime = await createRuntime({ databasePath: ':memory:' });
  const person = await runtime.app.executeAction(
    runtime.owner.id,
    'cli',
    'service.person.create',
    { displayName: 'Developer' },
  );
  const fetch = createDevelopmentHttpHandler({
    app: runtime.app,
    defaultActorId: runtime.owner.id,
  });
  const response = await fetch(
    new Request('http://datagram.test/v1/actions/channel.create', {
      body: JSON.stringify({ title: 'Selected developer', typeId: 'table' }),
      headers: { 'x-datagram-development-actor': person.subject!.id },
      method: 'POST',
    }),
  );
  expect(response.status).toBe(201);
  expect(response.headers.get('x-datagram-identity-mode')).toBe('development');
  const receipt = (await response.json()) as {
    operationId: string;
    subject: { id: string };
  };
  expect((await runtime.store.listOperations(receipt.subject.id))[0]?.actorId).toBe(
    person.subject!.id,
  );
});

test('HTTP dispatch enforces selected Channel Type contract against input Channel', async () => {
  runtime = await createRuntime({ databasePath: ':memory:' });
  const fetch = createDevelopmentHttpHandler({
    app: runtime.app,
    defaultActorId: runtime.owner.id,
  });
  const created = await runtime.app.executeAction(
    runtime.owner.id,
    'cli',
    'channel.create',
    { title: 'Dictionary', typeId: 'dictionary' },
  );
  const channelId = created.subject!.id;
  const selected = 'typeId=table&typeVersion=1.0.0';

  for (const [path, input] of [
    [`/v1/actions/discussion.message.post?${selected}`, { channelId, text: 'wrong type' }],
    [`/v1/queries/discussion.messages.list?${selected}`, { channelId }],
    [`/v1/agent/queries/discussion.messages.list?${selected}`, { channelId }],
  ] as const) {
    const response = await fetch(new Request(`http://datagram.test${path}`, {
      body: JSON.stringify(input),
      method: 'POST',
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'channel-type.version-mismatch' },
    });
  }
});
