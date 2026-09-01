import { afterEach, describe, expect, test } from 'bun:test';

import { viewDefinitionSchema, type QueryResult } from '../src/packages/application/views';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';
import { renderView } from '../src/packages/view-host';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('semantic View Definitions', () => {
  test('declare result meaning, bindings, and commands without host components', async () => {
    const value = await runtime();
    const table = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Inventory',
      typeId: 'table',
    });
    const tableId = table.subject!.id;
    const dictionary = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Products',
      typeId: 'dictionary',
    });
    const field = await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: tableId,
      key: 'name',
      label: 'Product name',
      required: false,
      type: 'text',
      unique: false,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId: tableId,
      values: { name: 'Apples' },
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.view.create', {
      channelId: tableId,
      filters: [],
      grouping: [],
      name: 'All products',
      sorting: [],
      visibility: 'personal',
      visibleFieldIds: [field.subject!.id],
    });
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.create', {
      channelId: dictionary.subject!.id,
      label: 'Fruit',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'discussion.message.post', {
      channelId: tableId,
      text: 'Stock checked',
    });

    const cases = [
      {
        binding: 'channels',
        commands: ['channel.create', 'channel.navigation.pin'],
        input: {},
        kind: 'channel-list',
        query: 'channel.list',
      },
      {
        binding: 'messages',
        commands: ['discussion.message.post', 'discussion.message.restore'],
        input: { channelId: tableId },
        kind: 'discussion',
        query: 'discussion.messages.list',
      },
      {
        binding: 'fields',
        commands: ['table.field.add'],
        input: { channelId: tableId },
        kind: 'table-schema',
        query: 'table.describe',
      },
      {
        binding: 'rows',
        commands: ['table.record.create', 'table.record.edit', 'table.record.tombstone', 'table.record.restore'],
        input: { channelId: tableId },
        kind: 'table-records',
        query: 'table.records.list',
      },
      {
        binding: 'views',
        commands: ['table.view.create'],
        input: { channelId: tableId },
        kind: 'table-views',
        query: 'table.views.list',
      },
      {
        binding: 'entries',
        commands: ['dictionary.entry.create', 'dictionary.entry.restore'],
        input: { channelId: dictionary.subject!.id },
        kind: 'dictionary',
        query: 'dictionary.entries.list',
      },
    ] as const;

    for (const item of cases) {
      const result = await value.app.executeQuery(value.owner.id, 'cli', item.query, item.input);
      expect(viewDefinitionSchema.parse(result.view)).toEqual(result.view);
      expect(result.view).toMatchObject({
        bindings: { [item.binding]: '$result' },
        kind: item.kind,
        schemaVersion: 'datagram/view@1',
      });
      expect(result.view.commands).toEqual(expect.arrayContaining([...item.commands]));
      expect(result.view).not.toHaveProperty('component');
      expect(result.view).not.toHaveProperty('html');
    }
  });

  test('trusted host resolves bindings directly and safely falls back for unknown meaning', async () => {
    const value = await runtime();
    const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Private title',
      typeId: 'table',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: channel.subject!.id,
      key: 'note',
      label: 'Note',
      required: false,
      type: 'text',
      unique: false,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId: channel.subject!.id,
      values: { note: '<script>not executed</script>' },
    });
    const result = await value.app.executeQuery(value.owner.id, 'cli', 'table.records.list', {
      channelId: channel.subject!.id,
    });

    expect(renderView(result)).toMatchObject({
      fallback: false,
      kind: 'table-records',
      semanticKind: 'table-records',
      title: 'Private title',
      values: { rows: result.data },
    });

    const future = {
      data: { payload: ['<b>plain value</b>'] },
      view: {
        bindings: { cards: '$result.payload' },
        commands: ['future.card.create'],
        kind: 'future-board',
        schemaVersion: 'datagram/view@1',
        title: 'Future board',
      },
    } satisfies QueryResult;
    expect(renderView(future)).toEqual({
      commands: ['future.card.create'],
      fallback: true,
      kind: 'generic',
      semanticKind: 'future-board',
      title: 'Future board',
      values: { cards: ['<b>plain value</b>'] },
    });
    expect(
      viewDefinitionSchema.safeParse({ ...future.view, component: 'UnsafeHostComponent' }).success,
    ).toBe(false);
    expect(
      viewDefinitionSchema.safeParse({ ...future.view, schemaVersion: 'datagram/view@2' }).success,
    ).toBe(false);
  });

  test('agent metadata excludes human titles, labels, and result values', async () => {
    const value = await runtime();
    const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Confidential inventory',
      typeId: 'table',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: channel.subject!.id,
      key: 'secret',
      label: 'Confidential label',
      required: false,
      type: 'text',
      unique: false,
    });

    const handle = await value.app.prepareQuery(value.owner.id, 'agent', 'table.describe', {
      channelId: channel.subject!.id,
    });
    expect(handle.view).toEqual({
      bindings: { fields: '$result' },
      commands: [
        'table.field.add',
        'table.field.tombstone',
        'table.field.restore',
        'table.field.convert',
        'table.field.purge',
        'table.record.create',
      ],
      kind: 'table-schema',
      schemaVersion: 'datagram/view@1',
    });
    expect(JSON.stringify(handle)).not.toContain('Confidential inventory');
    expect(JSON.stringify(handle)).not.toContain('Confidential label');

    const viewer = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: channel.subject!.id,
      personId: viewer.subject!.id,
      role: 'viewer',
    });
    const viewerHandle = await value.app.prepareQuery(
      viewer.subject!.id,
      'agent',
      'table.records.list',
      { channelId: channel.subject!.id },
    );
    expect(viewerHandle.view.commands).toEqual([]);
  });

  test('filters durable Table View mutation commands by Channel Role', async () => {
    const value = await runtime();
    const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Read-only view',
      typeId: 'table',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.view.create', {
      channelId: channel.subject!.id,
      filters: [],
      grouping: [],
      name: 'All records',
      sorting: [],
      visibility: 'shared',
      visibleFieldIds: [],
    });
    const view = (await value.store.listTableViews(channel.subject!.id, value.owner.id))[0]!;
    const viewer = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: channel.subject!.id,
      personId: viewer.subject!.id,
      role: 'viewer',
    });

    const opened = await value.app.executeQuery(viewer.subject!.id, 'cli', 'table.view.open', {
      channelId: channel.subject!.id,
      viewId: view.id,
    });
    expect(opened.view.commands).toEqual([]);
    const configuration = await value.app.executeQuery(
      viewer.subject!.id,
      'cli',
      'table.configuration',
      { channelId: channel.subject!.id },
    );
    expect(configuration.view.commands).toEqual([]);
    const availableViews = await value.app.executeQuery(
      viewer.subject!.id,
      'cli',
      'table.views.list',
      { channelId: channel.subject!.id },
    );
    expect(availableViews.view.commands).toEqual(['table.view.create']);
    await expect(value.app.executeAction(viewer.subject!.id, 'cli', 'table.view.create', {
      channelId: channel.subject!.id,
      filters: [],
      grouping: [],
      name: 'My personal view',
      sorting: [],
      visibility: 'personal',
      visibleFieldIds: [],
    })).resolves.toMatchObject({ action: 'table.view.create' });
  });
});
