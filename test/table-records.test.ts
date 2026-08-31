import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function setup() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Work',
    typeId: 'table',
  });
  return { channelId: channel.subject!.id, value };
}

async function addField(
  value: DatagramRuntime,
  channelId: string,
  input: Record<string, unknown>,
) {
  return value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
    channelId,
    required: false,
    unique: false,
    ...input,
  });
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('typed Table Record lifecycle', () => {
  test('enforces all primitive types, required, unique, and constant defaults atomically', async () => {
    const { channelId, value } = await setup();
    await addField(value, channelId, {
      key: 'name',
      label: 'Name',
      required: true,
      type: 'text',
      unique: true,
    });
    await addField(value, channelId, {
      defaultValue: 1,
      key: 'count',
      label: 'Count',
      type: 'number',
    });
    await addField(value, channelId, {
      defaultValue: false,
      key: 'enabled',
      label: 'Enabled',
      type: 'boolean',
    });
    await addField(value, channelId, {
      key: 'when',
      label: 'When',
      type: 'date-time',
    });

    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId, values: { name: 'First', when: '2026-09-01T12:30:00.000Z' } },
    );
    expect(await value.store.getTableRecord(created.subject!.id)).toMatchObject({
      values: { count: 1, enabled: false, name: 'First', when: '2026-09-01T12:30:00.000Z' },
    });

    const beforeOperations = await value.store.listOperations(channelId);
    const beforeActivities = await value.store.listActivities(channelId);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
        channelId,
        values: { name: 'First', unknown: 'rejected' },
      }),
    ).rejects.toMatchObject({ code: 'table.record-unknown-field' } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
        channelId,
        values: { name: 'First' },
      }),
    ).rejects.toMatchObject({ code: 'table.record-unique-field' } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
        channelId,
        values: { name: 'Second', when: 'tomorrow' },
      }),
    ).rejects.toMatchObject({ code: 'table.field-type' } satisfies Partial<DatagramError>);
    expect(await value.store.listTableRecords(channelId)).toHaveLength(1);
    expect(await value.store.listOperations(channelId)).toEqual(beforeOperations);
    expect(await value.store.listActivities(channelId)).toEqual(beforeActivities);
  });

  test('contributors edit any Record and tombstone/restore it without changing identity or values', async () => {
    const { channelId, value } = await setup();
    const nameField = await addField(value, channelId, {
      key: 'name',
      label: 'Name',
      required: true,
      type: 'text',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.display-field.set', {
      channelId,
      fieldId: nameField.subject!.id,
    });
    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId, values: { name: 'Original' } },
    );
    const person = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Contributor',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: person.subject!.id,
      role: 'contributor',
    });

    const before = (await value.store.listOperations(channelId)).length;
    for (const action of ['table.record.edit', 'table.record.tombstone', 'table.record.restore']) {
      await value.app.executeAction(person.subject!.id, 'http', action, {
        channelId,
        recordId: created.subject!.id,
        ...(action === 'table.record.edit' ? { values: { name: 'Changed' } } : {}),
      });
    }
    const record = await value.store.getTableRecord(created.subject!.id);
    expect(record).toMatchObject({ id: created.subject!.id, values: { name: 'Changed' } });
    expect(record?.tombstonedAt).toBeUndefined();
    expect((await value.store.listOperations(channelId)).slice(before).map((item) => item.action)).toEqual([
      'table.record.edit',
      'table.record.tombstone',
      'table.record.restore',
    ]);
    expect((await value.store.listActivities(channelId)).slice(-3).map((item) => item.kind)).toEqual([
      'table.record-edited',
      'table.record-tombstoned',
      'table.record-restored',
    ]);
    expect((await value.app.executeQuery(value.owner.id, 'cli', 'table.configuration', { channelId })).data)
      .toEqual({ displayFieldId: nameField.subject!.id });
  });

  test('stores personal/shared Views and hides personal definitions from other members', async () => {
    const { channelId, value } = await setup();
    const field = await addField(value, channelId, {
      key: 'name',
      label: 'Name',
      type: 'text',
    });
    const person = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: person.subject!.id,
      role: 'viewer',
    });
    const definition = {
      channelId,
      filters: [{ fieldId: field.subject!.id, operator: 'contains', value: 'A' }],
      grouping: [field.subject!.id],
      name: 'Mine',
      sorting: [{ direction: 'ascending', fieldId: field.subject!.id }],
      visibility: 'personal',
      visibleFieldIds: [field.subject!.id],
    };
    await value.app.executeAction(person.subject!.id, 'cli', 'table.view.create', definition);
    expect(await value.store.listTableViews(channelId, person.subject!.id)).toHaveLength(1);
    expect(await value.store.listTableViews(channelId, value.owner.id)).toHaveLength(0);
    await expect(
      value.app.executeAction(person.subject!.id, 'cli', 'table.view.create', {
        ...definition,
        name: 'Shared',
        visibility: 'shared',
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);
    await value.app.executeAction(value.owner.id, 'cli', 'table.view.create', {
      ...definition,
      name: 'Shared',
      visibility: 'shared',
    });
    expect(await value.store.listTableViews(channelId, person.subject!.id)).toHaveLength(2);
  });
});
