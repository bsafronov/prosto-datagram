import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

async function createChannel(value: DatagramRuntime, title: string, typeId = 'table') {
  const receipt = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title,
    typeId,
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

async function list(value: DatagramRuntime, personId: string, archived = false) {
  const result = await value.app.executeQuery(personId, 'cli', 'channel.list', { archived });
  return result.data as Array<{
    archivedAt: string | null;
    groups: Array<{ groupId: string; pinned: boolean; position: number }>;
    id: string;
    muted: boolean;
    pinned: boolean;
    unreadCount: number;
  }>;
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('Flat Channel List', () => {
  test('ranks every Channel Type as peers using meaningful Activity', async () => {
    const value = await runtime();
    const tableId = await createChannel(value, 'Table', 'table');
    const dictionaryId = await createChannel(value, 'Dictionary', 'dictionary');
    const chartId = await createChannel(value, 'Chart', 'chart');

    expect((await list(value, value.owner.id)).map((item) => item.id)).toEqual([
      chartId,
      dictionaryId,
      tableId,
    ]);

    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId: tableId,
      values: {},
    });
    expect((await list(value, value.owner.id)).map((item) => item.id)).toEqual([
      tableId,
      chartId,
      dictionaryId,
    ]);
  });

  test('supports personal overlapping groups, group order, and group-specific pins', async () => {
    const value = await runtime();
    const firstId = await createChannel(value, 'First');
    const secondId = await createChannel(value, 'Second');
    const otherId = await createPerson(value, 'Other');
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: firstId,
      personId: otherId,
      role: 'viewer',
    });

    const urgent = await value.app.executeAction(
      value.owner.id,
      'cli',
      'channel.group.create',
      { name: 'Urgent', position: 1 },
    );
    const reports = await value.app.executeAction(
      value.owner.id,
      'cli',
      'channel.group.create',
      { name: 'Reports', position: 0 },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.group.channel.add', {
      channelId: firstId,
      groupId: urgent.subject!.id,
      pinned: false,
      position: 2,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.group.channel.add', {
      channelId: firstId,
      groupId: reports.subject!.id,
      pinned: true,
      position: 3,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.group.channel.add', {
      channelId: secondId,
      groupId: reports.subject!.id,
      pinned: false,
      position: 0,
    });

    const ownerGroups = await value.app.executeQuery(
      value.owner.id,
      'cli',
      'channel.groups.list',
      {},
    );
    expect(ownerGroups.data).toEqual([
      {
        entries: [
          { channelId: firstId, pinned: true, position: 3 },
          { channelId: secondId, pinned: false, position: 0 },
        ],
        id: reports.subject!.id,
        name: 'Reports',
        position: 0,
      },
      {
        entries: [{ channelId: firstId, pinned: false, position: 2 }],
        id: urgent.subject!.id,
        name: 'Urgent',
        position: 1,
      },
    ]);
    expect((await list(value, value.owner.id)).find((item) => item.id === firstId)?.groups).toHaveLength(2);
    expect((await value.app.executeQuery(otherId, 'cli', 'channel.groups.list', {})).data).toEqual([]);
    await expect(
      value.app.executeAction(otherId, 'cli', 'channel.group.channel.add', {
        channelId: firstId,
        groupId: urgent.subject!.id,
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);

    expect((await value.store.getChannel(firstId))?.ownerId).toBe(value.owner.id);
    expect(await value.store.getMembership(firstId, otherId)).toMatchObject({ role: 'viewer' });
  });

  test('keeps archive, mute, unread, and pin state personal', async () => {
    const value = await runtime();
    const channelId = await createChannel(value, 'Shared');
    const otherId = await createPerson(value, 'Other');
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: otherId,
      role: 'contributor',
    });
    await value.app.executeAction(otherId, 'cli', 'channel.activity.mark-read', { channelId });
    await value.app.executeAction(otherId, 'cli', 'channel.navigation.mute', {
      channelId,
      muted: true,
    });
    await value.app.executeAction(otherId, 'cli', 'channel.navigation.archive', { channelId });

    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId,
      values: {},
    });
    expect(await list(value, otherId)).toEqual([]);
    expect(await list(value, value.owner.id)).toHaveLength(1);
    expect((await list(value, otherId, true))[0]).toMatchObject({
      id: channelId,
      muted: true,
      unreadCount: 1,
    });

    await value.app.executeAction(otherId, 'cli', 'channel.navigation.mute', {
      channelId,
      muted: false,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'discussion.message.post', {
      channelId,
      text: 'Return this Channel',
    });
    expect(await list(value, otherId, true)).toEqual([]);
    expect((await list(value, otherId))[0]).toMatchObject({
      id: channelId,
      muted: false,
      unreadCount: 2,
    });

    await value.app.executeAction(otherId, 'cli', 'channel.activity.mark-read', { channelId });
    expect((await list(value, otherId))[0]?.unreadCount).toBe(0);
    await value.app.executeAction(otherId, 'cli', 'channel.navigation.pin', {
      channelId,
      pinned: true,
      position: 4,
    });
    expect((await list(value, otherId))[0]).toMatchObject({ pinned: true });
    expect((await list(value, value.owner.id))[0]).toMatchObject({ pinned: false });
  });
});
