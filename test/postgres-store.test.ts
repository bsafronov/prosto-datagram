import { expect, test } from 'bun:test';

import { createDatagramApplication } from '../src/packages/application';
import { createHttpHandler } from '../src/packages/http';
import { createServerServiceRuntime, startServerService } from '../src/packages/server';
import { PostgresStore } from '../src/packages/postgres-store';
import { storeConformance } from './store-conformance';

const connectionString = process.env.DATAGRAM_TEST_POSTGRES_URL;

if (connectionString) {
  storeConformance('PostgreSQL', async () => {
    const serviceKey = `conformance-${crypto.randomUUID()}`;
    const stores: PostgresStore[] = [];
    const open = async () => {
      const store = new PostgresStore({ connectionString, serviceKey });
      await store.initialize();
      stores.push(store);
      return store;
    };
    return {
      dispose: async () => {
        await Promise.allSettled(stores.map((store) => store.close()));
      },
      reopen: open,
      store: await open(),
    };
  });

  test('Server Service starts with operator authority but no automatic Channel access', async () => {
    const serviceKey = `server-${crypto.randomUUID()}`;
    const runtime = await createServerServiceRuntime({
      connectionString,
      deploymentOperatorDisplayName: 'Operator',
      serviceKey,
    });
    try {
      expect(runtime.deploymentOperator).toMatchObject({
        displayName: 'Operator',
        isOperator: true,
      });
      expect(await runtime.store.listChannels(runtime.deploymentOperator.id)).toEqual([]);
      expect(await runtime.store.listOwnedChannels(runtime.deploymentOperator.id)).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test('Server Service maps bearer authentication to its Deployment Operator identity', async () => {
    const service = await startServerService({
      connectionString,
      deploymentOperatorToken: 'operator-secret',
      port: 0,
      serviceKey: `server-http-${crypto.randomUUID()}`,
    });
    try {
      const unauthorized = await fetch(new URL('/v1/queries', service.server.url));
      expect(unauthorized.status).toBe(401);
      const authorized = await fetch(new URL('/v1/queries', service.server.url), {
        headers: { authorization: 'Bearer operator-secret' },
      });
      expect(authorized.status).toBe(200);
      const channels = await fetch(new URL('/v1/queries/channel.list', service.server.url), {
        body: '{}',
        headers: { authorization: 'Bearer operator-secret' },
        method: 'POST',
      });
      expect(channels.status).toBe(200);
      expect(await channels.json()).toMatchObject({ data: [] });
    } finally {
      await service.server.stop();
      await service.runtime.close();
    }
  });

  test('authenticated identities collaborate against persisted authoritative state', async () => {
    const serviceKey = `collaboration-${crypto.randomUUID()}`;
    let runtime = await createServerServiceRuntime({ connectionString, serviceKey });
    try {
      const operatorId = runtime.deploymentOperator.id;
      const identities = new Map([['operator-token', operatorId]]);
      let fetch = createHttpHandler({
        app: runtime.app,
        verifyIdentity: (request) => {
          const authorization = request.headers.get('authorization');
          const actorId = authorization?.startsWith('Bearer ')
            ? identities.get(authorization.slice('Bearer '.length))
            : undefined;
          return actorId ? { actorId } : undefined;
        },
      });
      const action = async (
        token: string,
        name: string,
        input: Record<string, unknown>,
      ): Promise<{ subject?: { id: string } }> => {
        const response = await fetch(
          new Request(`http://datagram.test/v1/actions/${name}`, {
            body: JSON.stringify(input),
            headers: { authorization: `Bearer ${token}` },
            method: 'POST',
          }),
        );
        expect(response.status).toBe(201);
        return response.json() as Promise<{ subject?: { id: string } }>;
      };
      const table = await action('operator-token', 'channel.create', {
        title: 'Revenue',
        typeId: 'table',
      });
      const channelId = table.subject!.id;
      await action('operator-token', 'table.field.add', {
        channelId,
        key: 'amount',
        label: 'Amount',
        required: true,
        type: 'number',
        unique: false,
      });
      const collaborator = await action('operator-token', 'service.person.create', {
        displayName: 'Collaborator',
      });
      const collaboratorId = collaborator.subject!.id;
      identities.set('collaborator-token', collaboratorId);
      await action('operator-token', 'channel.member.grant', {
        channelId,
        personId: collaboratorId,
        role: 'contributor',
      });
      const record = await action('collaborator-token', 'table.record.create', {
        channelId,
        values: { amount: 42 },
      });
      await action('collaborator-token', 'discussion.message.post', {
        channelId,
        recordReferences: [record.subject!.id],
        text: 'Authoritative update',
      });
      const events = await runtime.store.listSubscriptionEvents(0, 100);
      expect(events.some((event) => event.type === 'activity')).toBeTrue();

      await runtime.close();
      runtime = await createServerServiceRuntime({ connectionString, serviceKey });
      fetch = createHttpHandler({
        app: runtime.app,
        verifyIdentity: (request) =>
          request.headers.get('authorization') === 'Bearer collaborator-token'
            ? { actorId: collaboratorId }
            : undefined,
      });
      expect(await runtime.store.getTableRecord(record.subject!.id)).toMatchObject({
        values: { amount: 42 },
      });
      expect(await runtime.store.listMessages(channelId)).toEqual([
        expect.objectContaining({ recordReferences: [record.subject!.id] }),
      ]);
      const response = await fetch(
        new Request('http://datagram.test/v1/queries/channel.list', {
          body: '{}',
          headers: { authorization: 'Bearer collaborator-token' },
          method: 'POST',
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()) as { data: unknown }).toMatchObject({
        data: [expect.objectContaining({ id: channelId })],
      });
    } finally {
      await runtime.close();
    }
  });

  test('concurrent Server Store writers preserve both committed Operations', async () => {
    const serviceKey = `concurrency-${crypto.randomUUID()}`;
    const first = new PostgresStore({ connectionString, serviceKey });
    const second = new PostgresStore({ connectionString, serviceKey });
    await Promise.all([first.initialize(), second.initialize()]);
    try {
      const operator = await first.ensureDeploymentOperator();
      const firstApp = createDatagramApplication(first);
      const secondApp = createDatagramApplication(second);
      const [firstReceipt, secondReceipt] = await Promise.all([
        firstApp.executeAction(operator.id, 'http', 'channel.create', {
          title: 'Concurrent first',
          typeId: 'table',
        }),
        secondApp.executeAction(operator.id, 'http', 'channel.create', {
          title: 'Concurrent second',
          typeId: 'table',
        }),
      ]);

      expect((await first.listChannels(operator.id)).map((channel) => channel.id)).toContain(
        firstReceipt.subject!.id,
      );
      expect((await second.listChannels(operator.id)).map((channel) => channel.id)).toContain(
        secondReceipt.subject!.id,
      );
      expect(await first.listOperations(firstReceipt.subject!.id)).toHaveLength(1);
      expect(await second.listOperations(secondReceipt.subject!.id)).toHaveLength(1);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  });
} else {
  test.skip('PostgreSQL Store conformance requires DATAGRAM_TEST_POSTGRES_URL', () => {});
}
