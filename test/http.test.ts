import { afterEach, expect, test } from 'bun:test';

import { createHttpHandler } from '../src/packages/http';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

let runtime: DatagramRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

test('HTTP adapter exposes the shared action and query contracts', async () => {
  runtime = await createRuntime({ databasePath: ':memory:' });
  const fetch = createHttpHandler({ app: runtime.app, defaultActorId: runtime.owner.id });

  const health = await fetch(new Request('http://datagram.test/health'));
  expect(await health.json()).toEqual({ status: 'ok' });

  const created = await fetch(
    new Request('http://datagram.test/v1/actions/channel.create', {
      body: JSON.stringify({ title: 'Products', typeId: 'table' }),
      method: 'POST',
    }),
  );
  expect(created.status).toBe(201);
  const receipt = (await created.json()) as { subject: { id: string } };

  const queried = await fetch(
    new Request('http://datagram.test/v1/queries/channel.list', {
      body: '{}',
      method: 'POST',
    }),
  );
  const result = (await queried.json()) as { data: { id: string }[] };
  expect(result.data[0]?.id).toBe(receipt.subject.id);

  const prepared = await fetch(
    new Request('http://datagram.test/v1/agent/queries/channel.list', {
      body: '{}',
      method: 'POST',
    }),
  );
  const sourceHandle = (await prepared.json()) as { id: string; purpose: string };
  expect(JSON.stringify(sourceHandle)).not.toContain('Products');

  const composed = await fetch(
    new Request('http://datagram.test/v1/agent/result-handles/compose', {
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
    new Request(`http://datagram.test/v1/result-handles/${composedHandle.id}`, {
      body: JSON.stringify({ purpose: 'trusted.render' }),
      method: 'POST',
    }),
  );
  expect((await rendered.json()) as { data: unknown }).toMatchObject({
    data: { 'Derived count': 1 },
  });
});
