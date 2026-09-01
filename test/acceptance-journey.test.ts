import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatagramApplicationPort } from '../src/packages/application/port';
import type { DatagramStore } from '../src/packages/application/store';
import type {
  OperationOrigin,
  Person,
  SubscriptionEvent,
} from '../src/packages/domain/model';
import { createRuntime } from '../src/packages/runtime';
import { createServerServiceRuntime } from '../src/packages/server';
import { renderView } from '../src/packages/view-host';

interface JourneyFixture {
  readonly app: DatagramApplicationPort;
  readonly close: () => Promise<void>;
  readonly deployment: 'local' | 'server';
  readonly operator: Person;
  readonly store: DatagramStore;
}

type JourneyFixtureFactory = () => Promise<JourneyFixture>;

async function take(
  events: AsyncIterable<SubscriptionEvent>,
  count: number,
): Promise<SubscriptionEvent[]> {
  const iterator = events[Symbol.asyncIterator]();
  const values: SubscriptionEvent[] = [];
  try {
    while (values.length < count) {
      const next = await iterator.next();
      if (next.done) break;
      values.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return values;
}

const futureExpiry = () => new Date(Date.now() + 60_000).toISOString();

function acceptanceJourney(name: string, createFixture: JourneyFixtureFactory): void {
  describe(`${name} Table-to-Chart acceptance journey`, () => {
    test('collaborates from Dictionary input through zero-data live Chart rendering', async () => {
      const fixture = await createFixture();
      const { app, operator, store } = fixture;
      try {
        expect(operator.isOperator).toBeTrue();
        expect(await store.listChannels(operator.id)).toEqual([]);
        if (fixture.deployment === 'local') {
          expect(await store.ensureLocalOwner('Ignored replacement name')).toEqual(operator);
        } else {
          expect(await store.listOwnedChannels(operator.id)).toEqual([]);
        }

        const dictionary = await app.executeAction(operator.id, 'cli', 'channel.create', {
          title: 'PRIVATE_STATUS_DICTIONARY',
          typeId: 'dictionary',
        });
        const entry = await app.executeAction(operator.id, 'cli', 'dictionary.entry.create', {
          channelId: dictionary.subject!.id,
          label: 'PRIVATE_READY_LABEL',
        });
        const table = await app.executeAction(operator.id, 'cli', 'channel.create', {
          title: 'PRIVATE_DELIVERY_TABLE',
          typeId: 'table',
        });
        await app.executeAction(operator.id, 'cli', 'table.field.add', {
          channelId: table.subject!.id,
          key: 'status',
          label: 'Status',
          required: true,
          targetChannelId: dictionary.subject!.id,
          type: 'dictionary',
          unique: false,
        });

        const contributor = await app.executeAction(
          operator.id,
          'cli',
          'service.person.create',
          { displayName: 'Contributor' },
        );
        const contributorId = contributor.subject!.id;
        await app.executeAction(operator.id, 'cli', 'channel.member.grant', {
          channelId: dictionary.subject!.id,
          personId: contributorId,
          role: 'viewer',
        });
        const invitation = await app.executeAction(
          operator.id,
          'cli',
          'channel.invitation.create',
          {
            channelId: table.subject!.id,
            expiresAt: futureExpiry(),
            role: 'contributor',
          },
        );
        await app.executeAction(contributorId, 'agent', 'channel.invitation.accept', {
          invitationId: invitation.subject!.id,
        });
        expect(await store.getMembership(table.subject!.id, contributorId)).toMatchObject({
          role: 'contributor',
        });

        await app.executeAction(operator.id, 'cli', 'channel.activity.mark-read', {
          channelId: table.subject!.id,
        });
        await app.executeAction(contributorId, 'cli', 'channel.activity.mark-read', {
          channelId: table.subject!.id,
        });
        const recencyCompetitor = await app.executeAction(
          operator.id,
          'cli',
          'channel.create',
          { title: 'Later activity', typeId: 'dictionary' },
        );
        const beforeRecency = await app.executeQuery(operator.id, 'cli', 'channel.list', {});
        expect((beforeRecency.data as Array<{ id: string }>)[0]?.id).toBe(
          recencyCompetitor.subject!.id,
        );

        const operationsBefore = await store.listOperations(table.subject!.id);
        const activitiesBefore = await store.listActivities(table.subject!.id);
        const eventsBefore = await store.listSubscriptionEvents(0, 1_000);
        const after = eventsBefore.at(-1)?.position ?? 0;
        const record = await app.executeAction(
          contributorId,
          'http',
          'table.record.create',
          {
            channelId: table.subject!.id,
            values: { status: entry.subject!.id },
          },
        );

        const operationsAfter = await store.listOperations(table.subject!.id);
        const activitiesAfter = await store.listActivities(table.subject!.id);
        expect(operationsAfter).toHaveLength(operationsBefore.length + 1);
        expect(activitiesAfter).toHaveLength(activitiesBefore.length + 1);
        expect(operationsAfter.at(-1)).toMatchObject({
          action: 'table.record.create',
          actorId: contributorId,
          id: record.operationId,
          origin: 'http',
          status: 'succeeded',
        });
        expect(activitiesAfter.at(-1)).toMatchObject({
          actorId: contributorId,
          kind: 'table.record-created',
          operationId: record.operationId,
        });

        const contributorEvents = await take(app.subscribe(contributorId, { after }), 2);
        expect(contributorEvents.map(({ type }) => type)).toEqual([
          'activity',
          'operation-result',
        ]);
        expect(contributorEvents.map(({ position }) => position)).toEqual(
          [...contributorEvents].map(({ position }) => position).sort((left, right) => left - right),
        );
        const observerEvents = await take(app.subscribe(operator.id, { after }), 1);
        expect(observerEvents[0]).toMatchObject({
          activity: { operationId: record.operationId },
          type: 'activity',
        });
        const activity = observerEvents[0]!.type === 'activity' ? observerEvents[0]!.activity : null;
        expect(activity).not.toBeNull();

        const unread = await app.executeQuery(operator.id, 'cli', 'channel.list', {});
        expect((unread.data as Array<{ id: string; unreadCount: number }>)[0]).toMatchObject({
          id: table.subject!.id,
          unreadCount: 1,
        });
        await app.executeAction(operator.id, 'cli', 'channel.activity.mark-read', {
          activityId: activity!.id,
          channelId: table.subject!.id,
        });
        expect(
          (await app.executeQuery(operator.id, 'cli', 'channel.list', {})).data,
        ).toContainEqual(expect.objectContaining({ id: table.subject!.id, unreadCount: 0 }));

        const source = await app.prepareQuery(
          contributorId,
          'agent',
          'table.records.list',
          { channelId: table.subject!.id },
          'chart.aggregate',
        );
        const aggregate = await app.composeResultHandle(contributorId, {
          handleId: source.id,
          inputPurpose: 'chart.aggregate',
          outputPurpose: 'chart.create',
          transform: {
            aggregations: [{ as: 'count', operator: 'count' }],
            kind: 'aggregate',
          },
        });
        const chart = await app.executeAction(contributorId, 'agent', 'chart.create', {
          handleId: aggregate.id,
          presentation: { series: ['count'], type: 'bar' },
          title: 'PRIVATE_LIVE_CHART',
        });
        const zeroDataOutput = JSON.stringify({ aggregate, chart, source });
        for (const forbidden of [
          'PRIVATE_DELIVERY_TABLE',
          'PRIVATE_LIVE_CHART',
          'PRIVATE_READY_LABEL',
          'PRIVATE_STATUS_DICTIONARY',
        ]) {
          expect(zeroDataOutput).not.toContain(forbidden);
        }
        expect(source).not.toHaveProperty('data');
        expect(aggregate).not.toHaveProperty('data');

        const clientOrigins = [
          ['CLI', 'cli'],
          ['HTTP', 'http'],
          ['MCP', 'mcp'],
          ['Codex', 'agent'],
          ['API', 'agent'],
        ] as const satisfies readonly (readonly [string, OperationOrigin])[];
        const auditEvidence: Array<{
          action: string;
          actorId: string;
          changeKinds: string[];
          client: string;
          origin: OperationOrigin;
          status: string;
        }> = [];
        for (const [client, origin] of clientOrigins) {
          const receipt = await app.executeAction(contributorId, origin, 'table.record.create', {
            channelId: table.subject!.id,
            values: { status: entry.subject!.id },
          });
          const operation = (await store.listOperations(table.subject!.id)).find(
            ({ id }) => id === receipt.operationId,
          )!;
          auditEvidence.push({
            action: operation.action,
            actorId: operation.actorId,
            changeKinds: operation.changes.map(({ kind }) => kind),
            client,
            origin: operation.origin,
            status: operation.status,
          });
        }
        expect(auditEvidence).toEqual(
          clientOrigins.map(([client, origin]) => ({
            action: 'table.record.create',
            actorId: contributorId,
            changeKinds: ['table.record-created', 'activity.appended'],
            client,
            origin,
            status: 'succeeded',
          })),
        );

        const opened = await app.executeQuery(contributorId, 'http', 'chart.open', {
          channelId: chart.subject!.id,
        });
        const rendered = renderView(opened);
        expect(rendered).toMatchObject({
          fallback: false,
          kind: 'chart',
          semanticKind: 'chart',
          values: { series: { count: 6 } },
        });
        expect(rendered.title).toBe('PRIVATE_LIVE_CHART');
      } finally {
        await fixture.close();
      }
    });
  });
}

acceptanceJourney('SQLite Local Service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-acceptance-'));
  const runtime = await createRuntime({ databasePath: join(directory, 'datagram.sqlite') });
  return {
    app: runtime.app,
    close: async () => {
      await runtime.close();
      await rm(directory, { force: true, recursive: true });
    },
    deployment: 'local',
    operator: runtime.owner,
    store: runtime.store,
  };
});

const postgresConnectionString = process.env.DATAGRAM_TEST_POSTGRES_URL;

if (postgresConnectionString) {
  acceptanceJourney('PostgreSQL Server Service', async () => {
    const runtime = await createServerServiceRuntime({
      connectionString: postgresConnectionString,
      serviceKey: `acceptance-${crypto.randomUUID()}`,
    });
    return {
      app: runtime.app,
      close: runtime.close,
      deployment: 'server',
      operator: runtime.deploymentOperator,
      store: runtime.store,
    };
  });
} else {
  test.skip('PostgreSQL acceptance journey requires DATAGRAM_TEST_POSTGRES_URL', () => {});
}
