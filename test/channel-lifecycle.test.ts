import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function setup() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Lifecycle',
    typeId: 'table',
  });
  return { channelId: channel.subject!.id, value };
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

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('shared Channel lifecycle', () => {
  test('transfers single ownership atomically and prevents Owner leave or deactivation', async () => {
    const { channelId, value } = await setup();
    const nextOwnerId = await createPerson(value, 'Next Owner');
    const before = await value.store.listOperations(channelId);

    await value.app.executeAction(value.owner.id, 'http', 'channel.owner.transfer', {
      channelId,
      personId: nextOwnerId,
    });

    expect((await value.store.getChannel(channelId))?.ownerId).toBe(nextOwnerId);
    expect(await value.store.getMembership(channelId, nextOwnerId)).toMatchObject({
      role: 'owner',
    });
    expect(await value.store.getMembership(channelId, value.owner.id)).toMatchObject({
      role: 'admin',
    });
    expect(await value.store.listOperations(channelId)).toHaveLength(before.length + 1);

    const beforeDenied = await value.store.listOperations(channelId);
    await expect(
      value.app.executeAction(nextOwnerId, 'cli', 'channel.member.leave', { channelId }),
    ).rejects.toMatchObject({
      code: 'channel.owner-cannot-leave',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'service.person.deactivate', {
        personId: nextOwnerId,
      }),
    ).rejects.toMatchObject({ code: 'person.owns-channels' } satisfies Partial<DatagramError>);
    expect(await value.store.listOperations(channelId)).toEqual(beforeDenied);

    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.leave', { channelId });
    expect(await value.store.getMembership(channelId, value.owner.id)).toBeNull();
    expect(await value.store.getMembership(channelId, nextOwnerId)).toMatchObject({
      role: 'owner',
    });
  });

  test('deletes and restores identity, data, membership, history, and reference resolution', async () => {
    const { channelId, value } = await setup();
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId,
      key: 'name',
      label: 'Name',
      type: 'text',
    });
    const record = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId, values: { name: 'Preserved' } },
    );
    const memberId = await createPerson(value, 'Member');
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: memberId,
      role: 'viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'discussion.message.post', {
      channelId,
      recordReferences: [record.subject!.id],
      text: 'Preserved history',
    });
    const source = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Reference Source',
      typeId: 'table',
    });
    const sourceChannelId = source.subject!.id;
    await value.app.executeAction(value.owner.id, 'cli', 'discussion.message.post', {
      channelId: sourceChannelId,
      recordReferences: [record.subject!.id],
      text: 'Surviving reference',
    });
    const operationIds = (await value.store.listOperations(channelId)).map(
      (operation) => operation.id,
    );

    expect(
      (
        await value.app.executeQuery(value.owner.id, 'cli', 'channel.reference.resolve', {
          channelId,
          recordId: record.subject!.id,
        })
      ).data,
    ).toEqual({ channelId, recordId: record.subject!.id, status: 'resolved' });
    expect(
      (
        await value.app.executeQuery(value.owner.id, 'cli', 'discussion.messages.list', {
          channelId: sourceChannelId,
        })
      ).data,
    ).toEqual([
      expect.objectContaining({
        recordReferences: [
          { channelId, recordId: record.subject!.id, status: 'resolved' },
        ],
      }),
    ]);

    await value.app.executeAction(value.owner.id, 'cli', 'channel.delete', { channelId });
    expect((await value.store.listChannels(value.owner.id)).map((channel) => channel.id)).not
      .toContain(channelId);
    expect((await value.store.getChannel(channelId))?.deletedAt).toEqual(expect.any(String));
    expect(await value.store.getTableRecord(record.subject!.id)).toMatchObject({
      id: record.subject!.id,
      values: { name: 'Preserved' },
    });
    expect(await value.store.getMembership(channelId, memberId)).toMatchObject({ role: 'viewer' });
    expect((await value.store.listOperations(channelId)).map((operation) => operation.id)).toEqual([
      ...operationIds,
      expect.any(String),
    ]);
    await expect(
      value.app.executeQuery(memberId, 'cli', 'table.records.list', { channelId }),
    ).rejects.toMatchObject({ code: 'channel.deleted' } satisfies Partial<DatagramError>);
    expect(
      (
        await value.app.executeQuery(value.owner.id, 'cli', 'channel.reference.resolve', {
          channelId,
          recordId: record.subject!.id,
        })
      ).data,
    ).toEqual({ channelId, recordId: record.subject!.id, status: 'unresolved' });
    expect(
      (
        await value.app.executeQuery(value.owner.id, 'cli', 'discussion.messages.list', {
          channelId: sourceChannelId,
        })
      ).data,
    ).toEqual([
      expect.objectContaining({
        recordReferences: [
          { channelId, recordId: record.subject!.id, status: 'unresolved' },
        ],
      }),
    ]);

    await value.app.executeAction(value.owner.id, 'cli', 'channel.restore', { channelId });
    expect((await value.store.listChannels(memberId)).map((channel) => channel.id)).toEqual([
      channelId,
    ]);
    expect(await value.store.getTableRecord(record.subject!.id)).toMatchObject({
      id: record.subject!.id,
      values: { name: 'Preserved' },
    });
    expect(await value.store.getMembership(channelId, memberId)).toMatchObject({ role: 'viewer' });
    const restoredOperations = await value.store.listOperations(channelId);
    expect(operationIds.every((id) => restoredOperations.some((item) => item.id === id))).toBeTrue();
    expect(
      (
        await value.app.executeQuery(memberId, 'cli', 'channel.reference.resolve', {
          channelId,
          recordId: record.subject!.id,
        })
      ).data,
    ).toEqual({ channelId, recordId: record.subject!.id, status: 'resolved' });
    expect(
      (
        await value.app.executeQuery(value.owner.id, 'cli', 'discussion.messages.list', {
          channelId: sourceChannelId,
        })
      ).data,
    ).toEqual([
      expect.objectContaining({
        recordReferences: [
          { channelId, recordId: record.subject!.id, status: 'resolved' },
        ],
      }),
    ]);

    const outsiderId = await createPerson(value, 'Outsider');
    expect(
      (
        await value.app.executeQuery(outsiderId, 'cli', 'channel.reference.resolve', {
          channelId,
          recordId: record.subject!.id,
        })
      ).data,
    ).toEqual({ channelId, recordId: record.subject!.id, status: 'unresolved' });

    await value.app.executeAction(value.owner.id, 'cli', 'table.record.tombstone', {
      channelId,
      recordId: record.subject!.id,
    });
    expect(
      (
        await value.app.executeQuery(memberId, 'cli', 'channel.reference.resolve', {
          channelId,
          recordId: record.subject!.id,
        })
      ).data,
    ).toEqual({ channelId, recordId: record.subject!.id, status: 'unresolved' });
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.restore', {
      channelId,
      recordId: record.subject!.id,
    });
    expect(
      (
        await value.app.executeQuery(memberId, 'cli', 'channel.reference.resolve', {
          channelId,
          recordId: record.subject!.id,
        })
      ).data,
    ).toEqual({ channelId, recordId: record.subject!.id, status: 'resolved' });
  });

  test('purges only through a distinct explicit approved Operation', async () => {
    const { channelId, value } = await setup();
    const record = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId, values: {} },
    );
    const message = await value.app.executeAction(
      value.owner.id,
      'cli',
      'discussion.message.post',
      { channelId, text: 'Purged with revisions' },
    );

    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'channel.purge', {
        approved: true,
        channelId,
      }),
    ).rejects.toMatchObject({ code: 'channel.not-deleted' } satisfies Partial<DatagramError>);
    await value.app.executeAction(value.owner.id, 'cli', 'channel.delete', { channelId });
    expect(await value.store.getTableRecord(record.subject!.id)).not.toBeNull();
    expect((await value.store.listOperations(channelId)).some((item) => item.action === 'channel.purge'))
      .toBeFalse();
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'channel.purge', {
        approved: false,
        channelId,
      }),
    ).rejects.toBeDefined();

    await value.app.executeAction(value.owner.id, 'cli', 'channel.purge', {
      approved: true,
      channelId,
    });
    expect(await value.store.getTableRecord(record.subject!.id)).toBeNull();
    expect(await value.store.getMessage(message.subject!.id)).toBeNull();
    expect(await value.store.getMembership(channelId, value.owner.id)).toBeNull();
    expect(await value.store.listActivities(channelId)).toEqual([]);
    expect((await value.store.listOperations(channelId)).map((item) => item.action)).toEqual([
      'channel.purge',
    ]);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'channel.restore', { channelId }),
    ).rejects.toMatchObject({ code: 'channel.purged' } satisfies Partial<DatagramError>);

    const dictionary = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Purge Dictionary',
      typeId: 'dictionary',
    });
    const entry = await value.app.executeAction(
      value.owner.id,
      'cli',
      'dictionary.entry.create',
      { channelId: dictionary.subject!.id, label: 'Purged Entry' },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.delete', {
      channelId: dictionary.subject!.id,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.purge', {
      approved: true,
      channelId: dictionary.subject!.id,
    });
    expect(await value.store.getDictionaryEntry(entry.subject!.id)).toBeNull();
  });
});
