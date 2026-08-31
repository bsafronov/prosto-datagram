import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import type { OperationOrigin } from '../src/packages/domain/model';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

async function createChannel(value: DatagramRuntime) {
  const receipt = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Invitations',
    typeId: 'table',
  });
  return receipt.subject!.id;
}

async function createPerson(value: DatagramRuntime, displayName: string) {
  const receipt = await value.app.executeAction(
    value.owner.id,
    'cli',
    'service.person.create',
    { displayName },
  );
  return receipt.subject!.id;
}

const futureExpiry = () => new Date(Date.now() + 60_000).toISOString();

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('Channel invitations and Service identities', () => {
  test('operator creates and deactivates identities without receiving Channel access', async () => {
    const value = await runtime();
    const channelOwnerId = await createPerson(value, 'Channel Owner');
    const created = await value.app.executeAction(channelOwnerId, 'cli', 'channel.create', {
      title: 'Operator-free Channel',
      typeId: 'table',
    });
    const channelId = created.subject!.id;
    const personId = await createPerson(value, 'Service Member');

    expect(await value.store.getMembership(channelId, value.owner.id)).toBeNull();
    expect(await value.store.getMembership(channelId, personId)).toBeNull();
    expect((await value.store.listChannels(personId)).map((channel) => channel.id)).toEqual([]);
    await expect(
      value.app.executeQuery(value.owner.id, 'cli', 'table.records.list', { channelId }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);

    const receipt = await value.app.executeAction(
      value.owner.id,
      'http',
      'service.person.deactivate',
      { personId },
    );
    expect(receipt.subject).toEqual({ id: personId, kind: 'person' });
    expect((await value.store.getPerson(personId))?.deactivatedAt).toBeDefined();
    expect((await value.store.listServiceOperations()).at(-1)).toMatchObject({
      action: 'service.person.deactivate',
      origin: 'http',
    });
    await expect(
      value.app.executeQuery(personId, 'cli', 'channel.list', {}),
    ).rejects.toMatchObject({ code: 'person.deactivated' } satisfies Partial<DatagramError>);
  });

  test('Owner and Admin invite existing and new Service members with scoped roles', async () => {
    const value = await runtime();
    const channelId = await createChannel(value);
    const adminId = await createPerson(value, 'Admin');
    const contributorId = await createPerson(value, 'Contributor');
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: adminId,
      role: 'admin',
    });

    const existingInvitation = await value.app.executeAction(
      adminId,
      'mcp',
      'channel.invitation.create',
      { channelId, expiresAt: futureExpiry(), role: 'contributor' },
    );
    await value.app.executeAction(contributorId, 'agent', 'channel.invitation.accept', {
      invitationId: existingInvitation.subject!.id,
    });
    expect(await value.store.getMembership(channelId, contributorId)).toEqual({
      channelId,
      personId: contributorId,
      role: 'contributor',
    });

    const newInvitation = await value.app.executeAction(
      value.owner.id,
      'http',
      'channel.invitation.create',
      { channelId, expiresAt: futureExpiry(), role: 'viewer' },
    );
    const accepted = await value.app.executeAction(
      value.owner.id,
      'workflow',
      'channel.invitation.accept',
      { displayName: 'New Viewer', invitationId: newInvitation.subject!.id },
    );
    const newPersonId = accepted.subject!.id;
    expect((await value.store.getPerson(newPersonId))?.displayName).toBe('New Viewer');
    expect(await value.store.getMembership(channelId, newPersonId)).toEqual({
      channelId,
      personId: newPersonId,
      role: 'viewer',
    });
    expect(await value.store.getMembership(channelId, value.owner.id)).toMatchObject({
      role: 'owner',
    });
  });

  test('role permissions, expiry, and denials leave state, Operation, and Activity unchanged', async () => {
    const value = await runtime();
    const channelId = await createChannel(value);
    const contributorId = await createPerson(value, 'Contributor');
    const viewerId = await createPerson(value, 'Viewer');
    for (const [personId, role] of [
      [contributorId, 'contributor'],
      [viewerId, 'viewer'],
    ] as const) {
      await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
        channelId,
        personId,
        role,
      });
    }

    await value.app.executeAction(contributorId, 'cli', 'table.record.create', {
      channelId,
      values: {},
    });
    await expect(
      value.app.executeAction(viewerId, 'cli', 'table.record.create', {
        channelId,
        values: {},
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);

    const beforeDeniedOperations = await value.store.listOperations(channelId);
    const beforeDeniedActivities = await value.store.listActivities(channelId);
    await expect(
      value.app.executeAction(contributorId, 'mcp', 'channel.invitation.create', {
        channelId,
        expiresAt: futureExpiry(),
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);
    expect(await value.store.listOperations(channelId)).toEqual(beforeDeniedOperations);
    expect(await value.store.listActivities(channelId)).toEqual(beforeDeniedActivities);

    const expiring = await value.app.executeAction(
      value.owner.id,
      'cli',
      'channel.invitation.create',
      {
        channelId,
        expiresAt: new Date(Date.now() + 10).toISOString(),
        role: 'viewer',
      },
    );
    const expiredTargetId = await createPerson(value, 'Expired Target');
    await Bun.sleep(20);
    const beforeExpiredOperations = await value.store.listOperations(channelId);
    const beforeExpiredActivities = await value.store.listActivities(channelId);
    await expect(
      value.app.executeAction(expiredTargetId, 'http', 'channel.invitation.accept', {
        invitationId: expiring.subject!.id,
      }),
    ).rejects.toMatchObject({ code: 'invitation.expired' } satisfies Partial<DatagramError>);
    expect(await value.store.listOperations(channelId)).toEqual(beforeExpiredOperations);
    expect(await value.store.listActivities(channelId)).toEqual(beforeExpiredActivities);
    expect(await value.store.getMembership(channelId, expiredTargetId)).toBeNull();
  });

  test('ownership transfer preserves exactly one Owner and enables prior Owner deactivation', async () => {
    const value = await runtime();
    const channelId = await createChannel(value);
    const nextOwnerId = await createPerson(value, 'Next Owner');

    const beforeDenied = await value.store.listServiceOperations();
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'service.person.deactivate', {
        personId: value.owner.id,
      }),
    ).rejects.toMatchObject({ code: 'person.owns-channels' } satisfies Partial<DatagramError>);
    expect(await value.store.listServiceOperations()).toEqual(beforeDenied);
    expect((await value.store.getPerson(value.owner.id))?.deactivatedAt).toBeUndefined();

    await value.app.executeAction(value.owner.id, 'cli', 'channel.owner.transfer', {
      channelId,
      personId: nextOwnerId,
    });
    expect((await value.store.getChannel(channelId))?.ownerId).toBe(nextOwnerId);
    expect(await value.store.getMembership(channelId, nextOwnerId)).toMatchObject({ role: 'owner' });
    expect(await value.store.getMembership(channelId, value.owner.id)).toMatchObject({ role: 'admin' });

    await value.app.executeAction(value.owner.id, 'cli', 'service.person.deactivate', {
      personId: value.owner.id,
    });
    expect((await value.store.getPerson(value.owner.id))?.deactivatedAt).toBeDefined();
  });

  test.each(['cli', 'http', 'mcp', 'agent', 'workflow', 'system'] as OperationOrigin[])(
    'invitation intent has equivalent behavior from %s origin',
    async (origin) => {
      const value = await runtime();
      const channelId = await createChannel(value);
      const receipt = await value.app.executeAction(
        value.owner.id,
        origin,
        'channel.invitation.create',
        { channelId, expiresAt: futureExpiry(), role: 'viewer' },
      );
      expect(await value.store.getInvitation(receipt.subject!.id)).toMatchObject({
        channelId,
        proposedRole: 'viewer',
      });
      expect(
        (await value.store.listOperations(channelId)).find(
          (operation) => operation.id === receipt.operationId,
        ),
      ).toMatchObject({
        action: 'channel.invitation.create',
        origin,
      });
    },
  );
});
