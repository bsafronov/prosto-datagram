import { describe, expect, test } from 'bun:test';

import { createDatagramApplication } from '../src/packages/application';
import { DatagramError } from '../src/packages/application/errors';
import type { DatagramStore } from '../src/packages/application/store';
import type {
  Channel,
  ChannelActivity,
  DomainChange,
  Operation,
  Person,
} from '../src/packages/domain/model';

export interface StoreFixture {
  readonly reopen: () => Promise<DatagramStore>;
  readonly store: DatagramStore;
  readonly dispose: () => Promise<void>;
}

export type StoreFixtureFactory = () => Promise<StoreFixture>;

const timestamp = (second: number): string => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

const operation = (input: {
  readonly action: string;
  readonly actorId: string;
  readonly changes: readonly DomainChange[];
  readonly channelId?: string;
  readonly id: string;
  readonly intent?: string;
  readonly result?: Operation['result'];
  readonly second: number;
}): Operation => ({
  action: input.action,
  actorId: input.actorId,
  changes: input.changes,
  ...(input.channelId ? { channelId: input.channelId } : {}),
  id: input.id,
  intent: input.intent ?? input.action,
  occurredAt: timestamp(input.second),
  origin: 'system',
  result: input.result ?? { status: 'succeeded' },
  status: 'succeeded',
});

const channel = (id: string, owner: Person, second: number): Channel => ({
  createdAt: timestamp(second),
  id,
  ownerId: owner.id,
  title: id,
  typeId: 'table',
  typeVersion: '1.0.0',
  updatedAt: timestamp(second),
});

const activity = (
  id: string,
  channelId: string,
  actorId: string,
  operationId: string,
  second: number,
): ChannelActivity => ({
  actorId,
  channelId,
  id,
  kind: 'channel.created',
  occurredAt: timestamp(second),
  operationId,
});

async function commitChannel(
  store: DatagramStore,
  owner: Person,
  id: string,
  second: number,
): Promise<Operation> {
  const operationId = `operation-${id}`;
  const value = operation({
    action: 'channel.create',
    actorId: owner.id,
    changes: [
      { channel: channel(id, owner, second), kind: 'channel.created' },
      {
        kind: 'membership.granted',
        membership: { channelId: id, personId: owner.id, role: 'owner' },
      },
      {
        activity: activity(`activity-${id}`, id, owner.id, operationId, second),
        kind: 'activity.appended',
      },
    ],
    channelId: id,
    id: operationId,
    second,
  });
  await store.commit(value);
  return value;
}

export function storeConformance(name: string, createFixture: StoreFixtureFactory): void {
  describe(`${name} Store conformance`, () => {
    test('persists identities, memberships, Channels, Activity, and ordering', async () => {
      const fixture = await createFixture();
      try {
        const owner = await fixture.store.ensureLocalOwner('Owner');
        expect(await fixture.store.ensureLocalOwner('Ignored')).toEqual(owner);
        await commitChannel(fixture.store, owner, 'channel-older', 1);
        await commitChannel(fixture.store, owner, 'channel-newer', 2);

        expect((await fixture.store.getPerson(owner.id))?.displayName).toBe('Owner');
        expect(await fixture.store.getMembership('channel-older', owner.id)).toEqual({
          channelId: 'channel-older',
          personId: owner.id,
          role: 'owner',
        });
        expect((await fixture.store.listChannels(owner.id)).map((value) => value.id)).toEqual([
          'channel-newer',
          'channel-older',
        ]);
        expect((await fixture.store.listActivities('channel-older')).map((value) => value.id)).toEqual([
          'activity-channel-older',
        ]);
      } finally {
        await fixture.dispose();
      }
    });

    test('preserves stable references and all Operation fields across restart', async () => {
      const fixture = await createFixture();
      let store = fixture.store;
      try {
        const owner = await store.ensureLocalOwner('Owner');
        await commitChannel(store, owner, 'channel-reference', 1);
        const recordId = 'record-reference';
        const operationId = 'operation-reference';
        await store.commit(
          operation({
            action: 'discussion.message.post',
            actorId: owner.id,
            changes: [
              {
                kind: 'table.record-created',
                record: {
                  channelId: 'channel-reference',
                  createdAt: timestamp(2),
                  createdBy: owner.id,
                  id: recordId,
                  values: { name: 'Preserved' },
                },
              },
              {
                kind: 'discussion.message-posted',
                message: {
                  authorId: owner.id,
                  channelId: 'channel-reference',
                  createdAt: timestamp(2),
                  id: 'message-reference',
                  recordReferences: [recordId, 'record-unresolved'],
                  text: 'References',
                },
              },
              {
                activity: activity(
                  'activity-reference',
                  'channel-reference',
                  owner.id,
                  operationId,
                  2,
                ),
                kind: 'activity.appended',
              },
            ],
            channelId: 'channel-reference',
            id: operationId,
            intent: 'post-message-with-stable-references',
            result: { messageId: 'message-reference' },
            second: 2,
          }),
        );
        await store.close();
        store = await fixture.reopen();

        expect((await store.listMessages('channel-reference'))[0]?.recordReferences).toEqual([
          recordId,
          'record-unresolved',
        ]);
        const persisted = (await store.listOperations('channel-reference'))[1];
        expect(persisted).toMatchObject({
          actorId: owner.id,
          changes: expect.any(Array),
          intent: 'post-message-with-stable-references',
          occurredAt: timestamp(2),
          origin: 'system',
          result: { messageId: 'message-reference' },
          status: 'succeeded',
        });
        expect(await store.listActivities('channel-reference')).toHaveLength(2);
      } finally {
        await store.close();
        await fixture.dispose();
      }
    });

    test('rolls back state, Operation History, and Activity at forced failure boundaries', async () => {
      const fixture = await createFixture();
      try {
        const store = fixture.store;
        const owner = await store.ensureLocalOwner('Owner');
        await commitChannel(store, owner, 'channel-atomic', 1);

        const invalidState = operation({
          action: 'channel.create',
          actorId: owner.id,
          changes: [
            { channel: channel('channel-rolled-back', owner, 2), kind: 'channel.created' },
            { channel: channel('channel-rolled-back', owner, 2), kind: 'channel.created' },
          ],
          channelId: 'channel-rolled-back',
          id: 'operation-invalid-state',
          second: 2,
        });
        await expect(store.commit(invalidState)).rejects.toThrow();
        expect(await store.getChannel('channel-rolled-back')).toBeNull();
        expect(await store.listOperations('channel-rolled-back')).toEqual([]);
        expect(await store.listActivities('channel-rolled-back')).toEqual([]);

        const duplicateOperationId = 'operation-channel-atomic';
        const recordChange: DomainChange = {
          kind: 'table.record-created',
          record: {
            channelId: 'channel-atomic',
            createdAt: timestamp(3),
            createdBy: owner.id,
            id: 'record-operation-failure',
            values: {},
          },
        };
        await expect(
          store.commit(
            operation({
              action: 'table.record.create',
              actorId: owner.id,
              changes: [recordChange],
              channelId: 'channel-atomic',
              id: duplicateOperationId,
              second: 3,
            }),
          ),
        ).rejects.toThrow();
        expect(await store.listTableRecords('channel-atomic')).toEqual([]);

        const activityFailure = operation({
          action: 'table.record.create',
          actorId: owner.id,
          changes: [
            {
              kind: 'table.record-created',
              record: {
                channelId: 'channel-atomic',
                createdAt: timestamp(4),
                createdBy: owner.id,
                id: 'record-activity-failure',
                values: {},
              },
            },
            {
              activity: activity(
                'activity-channel-atomic',
                'channel-atomic',
                owner.id,
                'operation-activity-failure',
                4,
              ),
              kind: 'activity.appended',
            },
          ],
          channelId: 'channel-atomic',
          id: 'operation-activity-failure',
          second: 4,
        });
        await expect(store.commit(activityFailure)).rejects.toThrow();
        expect(await store.listTableRecords('channel-atomic')).toEqual([]);
        expect(
          (await store.listOperations('channel-atomic')).some(
            (value) => value.id === activityFailure.id,
          ),
        ).toBeFalse();
        expect(await store.listActivities('channel-atomic')).toHaveLength(1);
      } finally {
        await fixture.dispose();
      }
    });

    test('enforces exactly one Owner per Channel atomically', async () => {
      const fixture = await createFixture();
      try {
        const store = fixture.store;
        const owner = await store.ensureLocalOwner('Owner');
        await commitChannel(store, owner, 'channel-owner', 1);
        const other: Person = {
          createdAt: timestamp(2),
          displayName: 'Other',
          id: 'person-other',
          isOperator: false,
        };
        await store.commit(
          operation({
            action: 'service.person.create',
            actorId: owner.id,
            changes: [{ kind: 'person.created', person: other }],
            id: 'operation-person-other',
            second: 2,
          }),
        );
        const before = await store.listOperations('channel-owner');

        await expect(
          store.commit(
            operation({
              action: 'channel.member.grant',
              actorId: owner.id,
              changes: [
                {
                  kind: 'membership.granted',
                  membership: {
                    channelId: 'channel-owner',
                    personId: other.id,
                    role: 'owner',
                  },
                },
              ],
              channelId: 'channel-owner',
              id: 'operation-second-owner',
              second: 3,
            }),
          ),
        ).rejects.toThrow();
        expect(await store.getMembership('channel-owner', other.id)).toBeNull();
        expect(await store.getMembership('channel-owner', owner.id)).toMatchObject({
          role: 'owner',
        });
        expect(await store.listOperations('channel-owner')).toEqual(before);
      } finally {
        await fixture.dispose();
      }
    });

    test('enforces Operation History visibility and conflict-safe undo', async () => {
      const fixture = await createFixture();
      try {
        const store = fixture.store;
        const owner = await store.ensureLocalOwner('Owner');
        const app = createDatagramApplication(store);
        const channelReceipt = await app.executeAction(owner.id, 'cli', 'channel.create', {
          title: 'History',
          typeId: 'table',
        });
        const channelId = channelReceipt.subject!.id;
        const contributorReceipt = await app.executeAction(
          owner.id,
          'cli',
          'service.person.create',
          { displayName: 'Contributor' },
        );
        const viewerReceipt = await app.executeAction(owner.id, 'cli', 'service.person.create', {
          displayName: 'Viewer',
        });
        const adminReceipt = await app.executeAction(owner.id, 'cli', 'service.person.create', {
          displayName: 'Admin',
        });
        const contributorId = contributorReceipt.subject!.id;
        const viewerId = viewerReceipt.subject!.id;
        const adminId = adminReceipt.subject!.id;
        const grant = await app.executeAction(owner.id, 'http', 'channel.member.grant', {
          channelId,
          personId: contributorId,
          role: 'contributor',
        });
        await app.executeAction(owner.id, 'cli', 'channel.member.grant', {
          channelId,
          personId: viewerId,
          role: 'viewer',
        });
        await app.executeAction(owner.id, 'cli', 'channel.member.grant', {
          channelId,
          personId: adminId,
          role: 'admin',
        });
        await app.executeAction(contributorId, 'mcp', 'table.record.create', {
          channelId,
          values: {},
        });

        const ownerHistory = await app.executeQuery(owner.id, 'cli', 'operation.history', {
          channelId,
        });
        const contributorHistory = await app.executeQuery(
          contributorId,
          'cli',
          'operation.history',
          { channelId },
        );
        const adminHistory = await app.executeQuery(adminId, 'cli', 'operation.history', {
          channelId,
        });
        expect((ownerHistory.data as unknown[]).length).toBeGreaterThan(1);
        expect(adminHistory.data).toEqual(ownerHistory.data);
        expect(contributorHistory.data).toEqual([
          expect.objectContaining({ actorId: contributorId, origin: 'mcp' }),
        ]);
        await expect(
          app.executeQuery(viewerId, 'cli', 'operation.history', { channelId }),
        ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);

        await app.executeAction(owner.id, 'cli', 'operation.undo', {
          channelId,
          operationId: grant.operationId,
        });
        expect(await store.getMembership(channelId, contributorId)).toBeNull();

        const changedGrant = await app.executeAction(owner.id, 'cli', 'channel.member.grant', {
          channelId,
          personId: contributorId,
          role: 'contributor',
        });
        await app.executeAction(owner.id, 'cli', 'channel.member.grant', {
          channelId,
          personId: contributorId,
          role: 'admin',
        });
        const before = await store.listOperations(channelId);
        await expect(
          app.executeAction(owner.id, 'cli', 'operation.undo', {
            channelId,
            operationId: changedGrant.operationId,
          }),
        ).rejects.toThrow('Membership changed after original Operation');
        expect((await store.getMembership(channelId, contributorId))?.role).toBe('admin');
        expect(await store.listOperations(channelId)).toHaveLength(before.length);
      } finally {
        await fixture.dispose();
      }
    });
  });
}
