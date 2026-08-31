import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatagramError } from '../src/domain/errors';
import { viewDefinitionSchema } from '../src/domain/model';
import { createRuntime, type DatagramRuntime } from '../src/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function runtime(databasePath = ':memory:') {
  const value = await createRuntime({ databasePath });
  openRuntimes.push(value);
  return value;
}

async function createTable(value: DatagramRuntime, title = 'Inventory') {
  const receipt = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title,
    typeId: 'table',
  });
  return receipt.subject!.id;
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('Datagram application', () => {
  test('executes one permissioned action contract across table and discussion behavior', async () => {
    const value = await runtime();
    const channelId = await createTable(value);

    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId,
      key: 'name',
      label: 'Name',
      required: true,
      type: 'text',
      unique: true,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId,
      key: 'available',
      label: 'Available',
      required: false,
      type: 'boolean',
      unique: false,
    });

    const person = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Contributor',
    });
    const contributorId = person.subject!.id;
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: contributorId,
      role: 'contributor',
    });
    const record = await value.app.executeAction(contributorId, 'http', 'table.record.create', {
      channelId,
      values: { available: true, name: 'Apples' },
    });
    await value.app.executeAction(contributorId, 'mcp', 'discussion.message.post', {
      channelId,
      recordReferences: [record.subject!.id],
      text: 'Stock checked',
    });

    const records = await value.app.executeQuery(contributorId, 'cli', 'table.records.list', {
      channelId,
    });
    const messages = await value.app.executeQuery(
      contributorId,
      'cli',
      'discussion.messages.list',
      { channelId },
    );
    expect(records.data).toEqual([
      { id: record.subject!.id, values: { available: true, name: 'Apples' } },
    ]);
    expect(messages.data).toHaveLength(1);
    expect(viewDefinitionSchema.parse(records.view)).toEqual(records.view);
    expect(await value.store.listOperations(channelId)).toHaveLength(6);
  });

  test('rejects insufficient roles and leaves no partial operation', async () => {
    const value = await runtime();
    const channelId = await createTable(value);
    const person = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Viewer',
    });
    const viewerId = person.subject!.id;
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: viewerId,
      role: 'viewer',
    });
    const before = await value.store.listOperations(channelId);

    try {
      await value.app.executeAction(viewerId, 'cli', 'table.field.add', {
        channelId,
        key: 'name',
        label: 'Name',
        type: 'text',
      });
      throw new Error('Expected permission denial');
    } catch (error) {
      expect(error).toBeInstanceOf(DatagramError);
      expect((error as DatagramError).code).toBe('permission.denied');
    }
    expect(await value.store.listOperations(channelId)).toHaveLength(before.length);
  });

  test('agent query returns no stored values or stored titles', async () => {
    const value = await runtime();
    const channelId = await createTable(value, 'Secret Inventory');
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId,
      key: 'name',
      label: 'Secret Product',
      required: true,
      type: 'text',
      unique: false,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId,
      values: { name: 'Hidden Apples' },
    });

    const handle = await value.app.prepareQuery(value.owner.id, 'mcp', 'table.records.list', {
      channelId,
    });
    const serialized = JSON.stringify(handle);
    expect(serialized).not.toContain('Secret Inventory');
    expect(serialized).not.toContain('Hidden Apples');
    expect(handle.view.title).toBe('table.records.list');

    const consumed = value.app.handles.consume(value.owner.id, handle.id, 'table.records.list');
    expect(JSON.stringify(consumed.data)).toContain('Hidden Apples');
  });

  test('persists SQLite state across runtime restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datagram-'));
    const databasePath = join(directory, 'datagram.sqlite');
    try {
      const first = await runtime(databasePath);
      const channelId = await createTable(first);
      await first.close();
      openRuntimes.splice(openRuntimes.indexOf(first), 1);

      const second = await runtime(databasePath);
      expect((await second.store.getChannel(channelId))?.title).toBe('Inventory');
      expect(second.owner.id).toBe(first.owner.id);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
