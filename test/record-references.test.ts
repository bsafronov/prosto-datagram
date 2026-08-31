import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function setup() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  const source = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Source',
    typeId: 'table',
  });
  const target = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Private Targets',
    typeId: 'table',
  });
  return {
    sourceChannelId: source.subject!.id,
    targetChannelId: target.subject!.id,
    value,
  };
}

async function createTarget(value: DatagramRuntime, channelId: string, name: string) {
  const fields = await value.store.listTableFields(channelId);
  if (!fields.some((field) => field.key === 'name')) {
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId,
      key: 'name',
      label: 'Name',
      type: 'text',
    });
  }
  return value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
    channelId,
    values: { name },
  });
}

async function addReferenceField(
  value: DatagramRuntime,
  sourceChannelId: string,
  targetChannelId: string,
  key: string,
  cardinality: 'one' | 'many',
) {
  return value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
    cardinality,
    channelId: sourceChannelId,
    key,
    label: key,
    targetChannelId,
    type: 'record-reference',
  });
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

describe('Record Reference Fields', () => {
  test('declare one target and cardinality, storing only validated stable identities', async () => {
    const { sourceChannelId, targetChannelId, value } = await setup();
    const first = await createTarget(value, targetChannelId, 'First secret');
    const second = await createTarget(value, targetChannelId, 'Second secret');
    await addReferenceField(value, sourceChannelId, targetChannelId, 'primary', 'one');
    await addReferenceField(value, sourceChannelId, targetChannelId, 'related', 'many');

    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'table.describe', {
        channelId: sourceChannelId,
      })).data,
    ).toEqual([
      expect.objectContaining({
        cardinality: 'one',
        key: 'primary',
        targetChannelId,
        type: 'record-reference',
      }),
      expect.objectContaining({
        cardinality: 'many',
        key: 'related',
        targetChannelId,
        type: 'record-reference',
      }),
    ]);

    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      {
        channelId: sourceChannelId,
        values: {
          primary: first.subject!.id,
          related: [first.subject!.id, second.subject!.id],
        },
      },
    );
    expect(await value.store.getTableRecord(created.subject!.id)).toMatchObject({
      values: {
        primary: first.subject!.id,
        related: [first.subject!.id, second.subject!.id],
      },
    });
    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'table.records.list', {
        channelId: sourceChannelId,
      })).data,
    ).toEqual([
      {
        id: created.subject!.id,
        values: {
          primary: { channelId: targetChannelId, recordId: first.subject!.id, status: 'resolved' },
          related: [
            { channelId: targetChannelId, recordId: first.subject!.id, status: 'resolved' },
            { channelId: targetChannelId, recordId: second.subject!.id, status: 'resolved' },
          ],
        },
      },
    ]);

    const otherTarget = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Other target',
      typeId: 'table',
    });
    const wrongRecord = await createTarget(value, otherTarget.subject!.id, 'Wrong channel');
    const before = await value.store.listOperations(sourceChannelId);
    for (const values of [
      { primary: [first.subject!.id] },
      { primary: wrongRecord.subject!.id },
      { related: [first.subject!.id, first.subject!.id] },
      { related: ['missing-record'] },
    ]) {
      await expect(
        value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
          channelId: sourceChannelId,
          values,
        }),
      ).rejects.toBeInstanceOf(DatagramError);
    }
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
        channelId: sourceChannelId,
        key: 'invalid',
        label: 'Invalid',
        type: 'record-reference',
      }),
    ).rejects.toMatchObject({
      code: 'table.field-reference-configuration',
    } satisfies Partial<DatagramError>);
    expect(await value.store.listOperations(sourceChannelId)).toEqual(before);
  });

  test('rechecks access and lifecycle without changing source references', async () => {
    const { sourceChannelId, targetChannelId, value } = await setup();
    const target = await createTarget(value, targetChannelId, 'Never reveal this label');
    await addReferenceField(value, sourceChannelId, targetChannelId, 'target', 'one');
    const source = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId: sourceChannelId, values: { target: target.subject!.id } },
    );
    const readerId = await createPerson(value, 'Reader');
    for (const channelId of [sourceChannelId, targetChannelId]) {
      await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
        channelId,
        personId: readerId,
        role: 'viewer',
      });
    }

    const resolution = async () => {
      const result = await value.app.executeQuery(readerId, 'cli', 'table.records.list', {
        channelId: sourceChannelId,
      });
      return (result.data as Array<{ values: { target: unknown } }>)[0]!.values.target;
    };
    expect(await resolution()).toEqual({
      channelId: targetChannelId,
      recordId: target.subject!.id,
      status: 'resolved',
    });

    await value.app.executeAction(readerId, 'cli', 'channel.member.leave', {
      channelId: targetChannelId,
    });
    expect(await resolution()).toEqual({
      channelId: targetChannelId,
      recordId: target.subject!.id,
      status: 'unresolved',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: targetChannelId,
      personId: readerId,
      role: 'viewer',
    });

    await value.app.executeAction(value.owner.id, 'cli', 'table.record.tombstone', {
      channelId: targetChannelId,
      recordId: target.subject!.id,
    });
    expect(await resolution()).toMatchObject({ status: 'unresolved' });
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.restore', {
      channelId: targetChannelId,
      recordId: target.subject!.id,
    });
    expect(await resolution()).toMatchObject({ status: 'resolved' });

    await value.app.executeAction(value.owner.id, 'cli', 'channel.delete', {
      channelId: targetChannelId,
    });
    expect(await resolution()).toMatchObject({ status: 'unresolved' });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.restore', {
      channelId: targetChannelId,
    });
    expect(await resolution()).toMatchObject({ status: 'resolved' });
    expect(await value.store.getTableRecord(source.subject!.id)).toMatchObject({
      values: { target: target.subject!.id },
    });
  });

  test('uses normal Operations and Activity while agent queries remain zero-data', async () => {
    const { sourceChannelId, targetChannelId, value } = await setup();
    const first = await createTarget(value, targetChannelId, 'First hidden value');
    const second = await createTarget(value, targetChannelId, 'Second hidden value');
    await addReferenceField(value, sourceChannelId, targetChannelId, 'target', 'one');
    const beforeOperations = (await value.store.listOperations(sourceChannelId)).length;
    const beforeActivities = (await value.store.listActivities(sourceChannelId)).length;

    const created = await value.app.executeAction(
      value.owner.id,
      'agent',
      'table.record.create',
      { channelId: sourceChannelId, values: { target: first.subject!.id } },
    );
    await value.app.executeAction(value.owner.id, 'mcp', 'table.record.edit', {
      channelId: sourceChannelId,
      recordId: created.subject!.id,
      values: { target: second.subject!.id },
    });

    expect(
      (await value.store.listOperations(sourceChannelId)).slice(beforeOperations).map(
        (operation) => [operation.action, operation.origin],
      ),
    ).toEqual([
      ['table.record.create', 'agent'],
      ['table.record.edit', 'mcp'],
    ]);
    expect(
      (await value.store.listActivities(sourceChannelId)).slice(beforeActivities).map(
        (activity) => activity.kind,
      ),
    ).toEqual(['table.record-created', 'table.record-edited']);

    const handle = await value.app.prepareQuery(
      value.owner.id,
      'mcp',
      'table.records.list',
      { channelId: sourceChannelId },
    );
    expect(JSON.stringify(handle)).not.toContain(second.subject!.id);
    expect(JSON.stringify(handle)).not.toContain('Second hidden value');
  });
});
