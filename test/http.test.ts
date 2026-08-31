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
  expect(JSON.stringify(await prepared.json())).not.toContain('Products');
});
