import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function setup() {
  const runtime = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(runtime);
  const channel = await runtime.app.executeAction(runtime.owner.id, 'cli', 'channel.create', {
    title: 'Concurrent work',
    typeId: 'table',
  });
  const channelId = channel.subject!.id;
  const first = await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.add', {
    channelId,
    key: 'first',
    label: 'First',
    required: false,
    type: 'text',
    unique: false,
  });
  const second = await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.add', {
    channelId,
    key: 'second',
    label: 'Second',
    required: false,
    type: 'text',
    unique: false,
  });
  const record = await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.record.create', {
    channelId,
    values: { first: 'A', second: 'B' },
  });
  return {
    channelId,
    fieldIds: { first: first.subject!.id, second: second.subject!.id },
    recordId: record.subject!.id,
    runtime,
  };
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((runtime) => runtime.close()));
});

describe('Table conflicts and schema evolution', () => {
  test('merges stale different-Field edits and atomically rejects a stale same-Field edit', async () => {
    const { channelId, recordId, runtime } = await setup();
    const observed = await runtime.store.getTableRecord(recordId);
    expect(observed?.fieldVersions).toEqual({ first: 1, second: 1 });

    await runtime.app.executeAction(runtime.owner.id, 'http', 'table.record.edit', {
      channelId,
      observedVersions: observed!.fieldVersions,
      recordId,
      values: { first: 'A2' },
    });
    await runtime.app.executeAction(runtime.owner.id, 'mcp', 'table.record.edit', {
      channelId,
      observedVersions: observed!.fieldVersions,
      recordId,
      values: { second: 'B2' },
    });
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      fieldVersions: { first: 2, second: 2 },
      values: { first: 'A2', second: 'B2' },
    });

    const beforeOperations = await runtime.store.listOperations(channelId);
    const beforeActivities = await runtime.store.listActivities(channelId);
    await expect(
      runtime.app.executeAction(runtime.owner.id, 'cli', 'table.record.edit', {
        channelId,
        observedVersions: observed!.fieldVersions,
        recordId,
        values: { first: 'lost', second: 'also lost' },
      }),
    ).rejects.toMatchObject({
      code: 'table.record-edit-conflict',
    } satisfies Partial<DatagramError>);
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      values: { first: 'A2', second: 'B2' },
    });
    expect(await runtime.store.listOperations(channelId)).toEqual(beforeOperations);
    expect(await runtime.store.listActivities(channelId)).toEqual(beforeActivities);

    const listed = await runtime.app.executeQuery(runtime.owner.id, 'cli', 'table.records.list', {
      channelId,
    });
    expect(listed.data).toEqual([
      {
        fieldVersions: { first: 2, second: 2 },
        id: recordId,
        values: { first: 'A2', second: 'B2' },
      },
    ]);
  });

  test('tombstones and restores Field definitions while retaining values until purge', async () => {
    const { channelId, fieldIds, recordId, runtime } = await setup();
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.tombstone', {
      channelId,
      fieldId: fieldIds.first,
      observedVersion: 1,
    });
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      values: { first: 'A' },
    });
    expect(
      (await runtime.app.executeQuery(runtime.owner.id, 'cli', 'table.describe', { channelId }))
        .data,
    ).toEqual([expect.objectContaining({ key: 'second' })]);
    expect(
      (await runtime.app.executeQuery(runtime.owner.id, 'cli', 'table.records.list', { channelId }))
        .data,
    ).toEqual([{ fieldVersions: { second: 1 }, id: recordId, values: { second: 'B' } }]);

    const retained = await runtime.store.getTableRecord(recordId);
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.record.edit', {
      channelId,
      observedVersions: retained!.fieldVersions,
      recordId,
      values: { second: 'B2' },
    });
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      values: { first: 'A', second: 'B2' },
    });

    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.restore', {
      channelId,
      fieldId: fieldIds.first,
      observedVersion: 2,
    });
    expect(
      (await runtime.app.executeQuery(runtime.owner.id, 'cli', 'table.records.list', { channelId }))
        .data,
    ).toEqual([
      {
        fieldVersions: { first: 1, second: 2 },
        id: recordId,
        values: { first: 'A', second: 'B2' },
      },
    ]);

    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.tombstone', {
      channelId,
      fieldId: fieldIds.first,
      observedVersion: 3,
    });
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.purge', {
      channelId,
      fieldId: fieldIds.first,
      observedVersion: 4,
    });
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      fieldVersions: { second: 2 },
      values: { second: 'B2' },
    });
  });

  test('previews every incompatible value and requires explicit conversion resolutions', async () => {
    const { channelId, fieldIds, recordId, runtime } = await setup();
    const other = await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.record.create', {
      channelId,
      values: { first: '12', second: 'C' },
    });
    const nullable = await runtime.app.executeAction(
      runtime.owner.id,
      'cli',
      'table.record.create',
      {
        channelId,
        values: { first: 'unknown', second: 'D' },
      },
    );
    const preview = await runtime.app.executeQuery(
      runtime.owner.id,
      'cli',
      'table.field.conversion.preview',
      {
        channelId,
        fieldId: fieldIds.first,
        targetType: 'number',
      },
    );
    expect(preview.data).toEqual({
      defaultFailure: null,
      failures: expect.arrayContaining([
        { originalValue: 'A', recordId },
        { originalValue: '12', recordId: other.subject!.id },
        { originalValue: 'unknown', recordId: nullable.subject!.id },
      ]),
      fieldId: fieldIds.first,
      observedVersion: 1,
      targetType: 'number',
    });
    expect((preview.data as { failures: unknown[] }).failures).toHaveLength(3);
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.convert', {
      cancel: true,
      channelId,
      fieldId: fieldIds.first,
      observedVersion: 1,
      targetType: 'number',
    });
    expect(
      (await runtime.store.listTableFields(channelId)).find((field) => field.id === fieldIds.first),
    ).toMatchObject({ type: 'text', version: 1 });
    const before = await runtime.store.listOperations(channelId);
    await expect(
      runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.convert', {
        channelId,
        fieldId: fieldIds.first,
        observedVersion: 1,
        resolutions: [{ kind: 'correct', recordId, value: 1 }],
        targetType: 'number',
      }),
    ).rejects.toMatchObject({
      code: 'table.field-conversion-unresolved',
    } satisfies Partial<DatagramError>);
    expect(await runtime.store.listOperations(channelId)).toEqual(before);

    const converted = await runtime.app.executeAction(
      runtime.owner.id,
      'cli',
      'table.field.convert',
      {
        channelId,
        fieldId: fieldIds.first,
        observedVersion: 1,
        resolutions: [
          { kind: 'correct', recordId, value: 1 },
          { kind: 'map', recordId: other.subject!.id, value: 12 },
          { kind: 'null', recordId: nullable.subject!.id },
        ],
        targetType: 'number',
      },
    );
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      values: { first: 1 },
    });
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'operation.undo', {
      channelId,
      operationId: converted.operationId,
    });
    expect(await runtime.store.getTableRecord(recordId)).toMatchObject({
      values: { first: 'A' },
    });
    expect(await runtime.store.getTableRecord(nullable.subject!.id)).toMatchObject({
      values: { first: 'unknown' },
    });
    expect(
      (await runtime.store.listTableFields(channelId)).find((field) => field.id === fieldIds.first),
    ).toMatchObject({ type: 'text', version: 3 });
  });

  test('Record and schema undo reject later conflicting Operations without partial state', async () => {
    const { channelId, fieldIds, recordId, runtime } = await setup();
    const observed = await runtime.store.getTableRecord(recordId);
    const firstEdit = await runtime.app.executeAction(
      runtime.owner.id,
      'cli',
      'table.record.edit',
      {
        channelId,
        observedVersions: observed!.fieldVersions,
        recordId,
        values: { first: 'A2' },
      },
    );
    const next = await runtime.store.getTableRecord(recordId);
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.record.edit', {
      channelId,
      observedVersions: next!.fieldVersions,
      recordId,
      values: { first: 'A3' },
    });
    const before = await runtime.store.listOperations(channelId);
    await expect(
      runtime.app.executeAction(runtime.owner.id, 'cli', 'operation.undo', {
        channelId,
        operationId: firstEdit.operationId,
      }),
    ).rejects.toMatchObject({
      code: 'operation.undo-conflict',
    } satisfies Partial<DatagramError>);
    expect(await runtime.store.listOperations(channelId)).toEqual(before);

    const tombstone = await runtime.app.executeAction(
      runtime.owner.id,
      'cli',
      'table.field.tombstone',
      {
        channelId,
        fieldId: fieldIds.second,
        observedVersion: 1,
      },
    );
    await runtime.app.executeAction(runtime.owner.id, 'cli', 'table.field.restore', {
      channelId,
      fieldId: fieldIds.second,
      observedVersion: 2,
    });
    await expect(
      runtime.app.executeAction(runtime.owner.id, 'cli', 'operation.undo', {
        channelId,
        operationId: tombstone.operationId,
      }),
    ).rejects.toMatchObject({
      code: 'operation.undo-conflict',
    } satisfies Partial<DatagramError>);
  });
});
