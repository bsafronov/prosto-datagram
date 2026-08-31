import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function setup() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Products',
    typeId: 'dictionary',
  });
  return { channelId: channel.subject!.id, value };
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('Dictionary Entry lifecycle', () => {
  test('normalizes labels and rejects Unicode-equivalent case-insensitive duplicates atomically', async () => {
    const { channelId, value } = await setup();
    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'dictionary.entry.create',
      { channelId, label: '  Cafe\u0301  ' },
    );

    expect(await value.store.getDictionaryEntry(created.subject!.id)).toMatchObject({
      id: created.subject!.id,
      label: 'Café',
    });
    const beforeOperations = await value.store.listOperations(channelId);
    const beforeActivities = await value.store.listActivities(channelId);

    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.create', {
        channelId,
        label: 'CAFÉ',
      }),
    ).rejects.toMatchObject({
      code: 'dictionary.entry-label-conflict',
    } satisfies Partial<DatagramError>);
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.create', {
      channelId,
      label: 'Straße',
    });
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.create', {
        channelId,
        label: 'STRASSE',
      }),
    ).rejects.toMatchObject({
      code: 'dictionary.entry-label-conflict',
    } satisfies Partial<DatagramError>);
    expect(await value.store.listDictionaryEntries(channelId)).toHaveLength(2);
    expect((await value.store.listOperations(channelId)).length).toBe(
      beforeOperations.length + 1,
    );
    expect((await value.store.listActivities(channelId)).length).toBe(
      beforeActivities.length + 1,
    );
  });

  test('lets Contributors rename, retire, resolve, and restore stable Entries', async () => {
    const { channelId, value } = await setup();
    const contributor = await value.app.executeAction(
      value.owner.id,
      'cli',
      'service.person.create',
      { displayName: 'Contributor' },
    );
    const contributorId = contributor.subject!.id;
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: contributorId,
      role: 'contributor',
    });
    const before = (await value.store.listOperations(channelId)).length;
    const created = await value.app.executeAction(
      contributorId,
      'http',
      'dictionary.entry.create',
      { channelId, label: 'Original' },
    );
    const entryId = created.subject!.id;

    await value.app.executeAction(contributorId, 'mcp', 'dictionary.entry.rename', {
      channelId,
      entryId,
      label: ' Renamed ',
    });
    await value.app.executeAction(contributorId, 'cli', 'dictionary.entry.retire', {
      channelId,
      entryId,
    });
    expect(await value.store.getDictionaryEntry(entryId)).toMatchObject({
      id: entryId,
      label: 'Renamed',
      retiredAt: expect.any(String),
    });
    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'dictionary.entries.list', {
        channelId,
      })).data,
    ).toEqual([]);
    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'dictionary.entries.list', {
        channelId,
        includeRetired: true,
      })).data,
    ).toEqual([{ id: entryId, label: 'Renamed', retiredAt: expect.any(String) }]);

    await value.app.executeAction(contributorId, 'cli', 'dictionary.entry.restore', {
      channelId,
      entryId,
    });
    expect(await value.store.getDictionaryEntry(entryId)).toMatchObject({
      id: entryId,
      label: 'Renamed',
    });
    expect((await value.store.getDictionaryEntry(entryId))?.retiredAt).toBeUndefined();
    expect((await value.store.listOperations(channelId)).slice(before).map((item) => item.action))
      .toEqual([
        'dictionary.entry.create',
        'dictionary.entry.rename',
        'dictionary.entry.retire',
        'dictionary.entry.restore',
      ]);
    expect((await value.store.listActivities(channelId)).slice(-4).map((item) => item.kind))
      .toEqual([
        'dictionary.entry-created',
        'dictionary.entry-renamed',
        'dictionary.entry-retired',
        'dictionary.entry-restored',
      ]);
  });

  test('denies Viewers Entry writes and keeps agent query output zero-data', async () => {
    const { channelId, value } = await setup();
    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'dictionary.entry.create',
      { channelId, label: 'Hidden value' },
    );
    const viewer = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: viewer.subject!.id,
      role: 'viewer',
    });
    const before = await value.store.listOperations(channelId);

    await expect(
      value.app.executeAction(viewer.subject!.id, 'cli', 'dictionary.entry.rename', {
        channelId,
        entryId: created.subject!.id,
        label: 'Exposed',
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);
    expect(await value.store.listOperations(channelId)).toEqual(before);

    const handle = await value.app.prepareQuery(
      viewer.subject!.id,
      'agent',
      'dictionary.entries.list',
      { channelId, includeRetired: true },
    );
    expect(JSON.stringify(handle)).not.toContain('Hidden value');
    expect(handle.view.title).toBe('dictionary.entries.list');
  });
});
