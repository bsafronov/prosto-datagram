import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function createChannel(
  value: DatagramRuntime,
  title: string,
  typeId: 'dictionary' | 'table',
) {
  return value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title,
    typeId,
  });
}

async function setup() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  const table = await createChannel(value, 'Inventory', 'table');
  const dictionary = await createChannel(value, 'Products', 'dictionary');
  const otherDictionary = await createChannel(value, 'Countries', 'dictionary');
  const entry = await value.app.executeAction(
    value.owner.id,
    'cli',
    'dictionary.entry.create',
    { channelId: dictionary.subject!.id, label: 'Apples' },
  );
  const otherEntry = await value.app.executeAction(
    value.owner.id,
    'cli',
    'dictionary.entry.create',
    { channelId: otherDictionary.subject!.id, label: 'France' },
  );
  return {
    dictionaryId: dictionary.subject!.id,
    entryId: entry.subject!.id,
    otherDictionaryId: otherDictionary.subject!.id,
    otherEntryId: otherEntry.subject!.id,
    tableId: table.subject!.id,
    value,
  };
}

async function addDictionaryField(
  value: DatagramRuntime,
  tableId: string,
  dictionaryId: string,
) {
  return value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
    channelId: tableId,
    key: 'product',
    label: 'Product',
    required: true,
    targetChannelId: dictionaryId,
    type: 'dictionary',
    unique: false,
  });
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('Dictionary-backed Table Fields', () => {
  test('binds exactly one Dictionary and accepts stable active Entry identities', async () => {
    const { dictionaryId, entryId, tableId, value } = await setup();

    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
        channelId: tableId,
        key: 'missing_dictionary',
        label: 'Missing Dictionary',
        required: false,
        type: 'dictionary',
        unique: false,
      }),
    ).rejects.toMatchObject({
      code: 'table.field-dictionary-configuration',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
        channelId: tableId,
        key: 'bad_text',
        label: 'Bad Text',
        required: false,
        targetChannelId: dictionaryId,
        type: 'text',
        unique: false,
      }),
    ).rejects.toMatchObject({
      code: 'table.field-dictionary-configuration',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
        cardinality: 'one',
        channelId: tableId,
        key: 'bad_dictionary',
        label: 'Bad Dictionary',
        required: false,
        targetChannelId: dictionaryId,
        type: 'dictionary',
        unique: false,
      }),
    ).rejects.toMatchObject({
      code: 'table.field-reference-configuration',
    } satisfies Partial<DatagramError>);

    const field = await addDictionaryField(value, tableId, dictionaryId);
    await value.app.executeAction(value.owner.id, 'cli', 'table.display-field.set', {
      channelId: tableId,
      fieldId: field.subject!.id,
    });
    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId: tableId, values: { product: entryId } },
    );

    expect(await value.store.listTableFields(tableId)).toContainEqual(
      expect.objectContaining({
        id: field.subject!.id,
        targetChannelId: dictionaryId,
        type: 'dictionary',
      }),
    );
    expect(await value.store.getTableRecord(created.subject!.id)).toMatchObject({
      values: { product: entryId },
    });
    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'table.records.list', {
        channelId: tableId,
      })).data,
    ).toEqual([
      {
        fieldVersions: { product: 1 },
        id: created.subject!.id,
        values: {
          product: { entryId, label: 'Apples', status: 'resolved' },
        },
      },
    ]);
  });

  test('rejects missing, retired, inaccessible, and wrong-Dictionary Entries atomically', async () => {
    const { dictionaryId, entryId, otherEntryId, tableId, value } = await setup();
    await addDictionaryField(value, tableId, dictionaryId);
    const member = await value.app.executeAction(
      value.owner.id,
      'cli',
      'service.person.create',
      { displayName: 'Table-only Contributor' },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: tableId,
      personId: member.subject!.id,
      role: 'contributor',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.retire', {
      channelId: dictionaryId,
      entryId,
    });
    const activeEntry = await value.app.executeAction(
      value.owner.id,
      'cli',
      'dictionary.entry.create',
      { channelId: dictionaryId, label: 'Pears' },
    );
    const beforeOperations = await value.store.listOperations(tableId);
    const beforeActivities = await value.store.listActivities(tableId);

    for (const candidate of ['missing-entry', entryId, otherEntryId]) {
      await expect(
        value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
          channelId: tableId,
          values: { product: candidate },
        }),
      ).rejects.toMatchObject({
        code: 'table.dictionary-entry-invalid',
      } satisfies Partial<DatagramError>);
    }
    for (const origin of ['cli', 'http', 'mcp', 'agent', 'workflow', 'system'] as const) {
      await expect(
        value.app.executeAction(member.subject!.id, origin, 'table.record.create', {
          channelId: tableId,
          values: { product: activeEntry.subject!.id },
        }),
      ).rejects.toMatchObject({
        code: 'table.dictionary-entry-invalid',
      } satisfies Partial<DatagramError>);
    }

    expect(await value.store.listTableRecords(tableId)).toEqual([]);
    expect(await value.store.listOperations(tableId)).toEqual(beforeOperations);
    expect(await value.store.listActivities(tableId)).toEqual(beforeActivities);
  });

  test('resolves retired Entries and renames for authorized viewers without Record rewrites', async () => {
    const { dictionaryId, entryId, tableId, value } = await setup();
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: tableId,
      key: 'note',
      label: 'Note',
      required: false,
      type: 'text',
      unique: false,
    });
    await addDictionaryField(value, tableId, dictionaryId);
    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId: tableId, values: { note: 'before', product: entryId } },
    );
    const storedBefore = await value.store.getTableRecord(created.subject!.id);

    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.rename', {
      channelId: dictionaryId,
      entryId,
      label: 'Green Apples',
    });
    expect(await value.store.getTableRecord(created.subject!.id)).toEqual(storedBefore);
    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'table.records.list', {
        channelId: tableId,
      })).data,
    ).toEqual([
      {
        fieldVersions: { note: 1, product: 1 },
        id: created.subject!.id,
        values: {
          note: 'before',
          product: { entryId, label: 'Green Apples', status: 'resolved' },
        },
      },
    ]);
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.retire', {
      channelId: dictionaryId,
      entryId,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.edit', {
      channelId: tableId,
      observedVersions: { note: 1 },
      recordId: created.subject!.id,
      values: { note: 'after' },
    });

    expect(storedBefore?.values.product).toBe(entryId);
    expect((await value.store.getTableRecord(created.subject!.id))?.values.product).toBe(
      entryId,
    );
    expect(
      (await value.app.executeQuery(value.owner.id, 'cli', 'table.records.list', {
        channelId: tableId,
      })).data,
    ).toEqual([
      {
        fieldVersions: { note: 2, product: 1 },
        id: created.subject!.id,
        values: {
          note: 'after',
          product: { entryId, label: 'Green Apples', status: 'retired' },
        },
      },
    ]);
  });

  test('does not transfer Dictionary access through Table membership', async () => {
    const { dictionaryId, entryId, tableId, value } = await setup();
    await addDictionaryField(value, tableId, dictionaryId);
    const created = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId: tableId, values: { product: entryId } },
    );
    const viewer = await value.app.executeAction(
      value.owner.id,
      'cli',
      'service.person.create',
      { displayName: 'Table-only Viewer' },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: tableId,
      personId: viewer.subject!.id,
      role: 'viewer',
    });

    expect(
      (await value.app.executeQuery(viewer.subject!.id, 'cli', 'table.records.list', {
        channelId: tableId,
      })).data,
    ).toEqual([
      {
        fieldVersions: { product: 1 },
        id: created.subject!.id,
        values: { product: { entryId, status: 'unresolved' } },
      },
    ]);
    await expect(
      value.app.executeQuery(viewer.subject!.id, 'cli', 'dictionary.entries.list', {
        channelId: dictionaryId,
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);
    const handle = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId: tableId },
    );
    expect(JSON.stringify(handle)).not.toContain('Apples');
    expect(JSON.stringify(handle)).not.toContain(entryId);
  });

  test('requires a Dictionary target for empty-Table conversion', async () => {
    const { dictionaryId, tableId, value } = await setup();
    const field = await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: tableId,
      key: 'legacy',
      label: 'Legacy',
      required: false,
      type: 'text',
      unique: false,
    });

    await expect(
      value.app.executeQuery(value.owner.id, 'cli', 'table.field.conversion.preview', {
        channelId: tableId,
        fieldId: field.subject!.id,
        targetType: 'dictionary',
      }),
    ).rejects.toMatchObject({
      code: 'table.field-dictionary-configuration',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'table.field.convert', {
        channelId: tableId,
        fieldId: field.subject!.id,
        observedVersion: 1,
        targetType: 'dictionary',
      }),
    ).rejects.toMatchObject({
      code: 'table.field-dictionary-configuration',
    } satisfies Partial<DatagramError>);

    await value.app.executeAction(value.owner.id, 'cli', 'table.field.convert', {
      channelId: tableId,
      fieldId: field.subject!.id,
      observedVersion: 1,
      targetChannelId: dictionaryId,
      targetType: 'dictionary',
    });
    expect(
      (await value.store.listTableFields(tableId)).find(
        (candidate) => candidate.id === field.subject!.id,
      ),
    ).toMatchObject({ targetChannelId: dictionaryId, type: 'dictionary', version: 2 });
  });

  test('previews invalid Dictionary conversions and requires target access', async () => {
    const { dictionaryId, entryId, otherEntryId, tableId, value } = await setup();
    const activeEntry = await value.app.executeAction(
      value.owner.id,
      'cli',
      'dictionary.entry.create',
      { channelId: dictionaryId, label: 'Pears' },
    );
    const field = await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: tableId,
      key: 'legacy',
      label: 'Legacy',
      required: false,
      type: 'text',
      unique: false,
    });
    const recordIds: string[] = [];
    for (const legacy of ['missing-entry', entryId, otherEntryId, activeEntry.subject!.id]) {
      const record = await value.app.executeAction(
        value.owner.id,
        'cli',
        'table.record.create',
        { channelId: tableId, values: { legacy } },
      );
      recordIds.push(record.subject!.id);
    }
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.retire', {
      channelId: dictionaryId,
      entryId,
    });

    const preview = await value.app.executeQuery(
      value.owner.id,
      'cli',
      'table.field.conversion.preview',
      {
        channelId: tableId,
        fieldId: field.subject!.id,
        targetChannelId: dictionaryId,
        targetType: 'dictionary',
      },
    );
    const failures = (preview.data as { failures: { recordId: string }[] }).failures;
    expect(failures.map((failure) => failure.recordId).sort()).toEqual(
      recordIds.slice(0, 3).sort(),
    );

    const admin = await value.app.executeAction(
      value.owner.id,
      'cli',
      'service.person.create',
      { displayName: 'Table-only Admin' },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: tableId,
      personId: admin.subject!.id,
      role: 'admin',
    });
    await expect(
      value.app.executeQuery(admin.subject!.id, 'cli', 'table.field.conversion.preview', {
        channelId: tableId,
        fieldId: field.subject!.id,
        targetChannelId: dictionaryId,
        targetType: 'dictionary',
      }),
    ).rejects.toMatchObject({ code: 'permission.denied' } satisfies Partial<DatagramError>);
  });

  test('validates Dictionary conversion defaults and Record resolutions centrally', async () => {
    const { dictionaryId, entryId, otherEntryId, tableId, value } = await setup();
    const retired = await value.app.executeAction(
      value.owner.id,
      'cli',
      'dictionary.entry.create',
      { channelId: dictionaryId, label: 'Retired' },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.retire', {
      channelId: dictionaryId,
      entryId: retired.subject!.id,
    });
    const field = await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId: tableId,
      defaultValue: 'missing-default',
      key: 'legacy',
      label: 'Legacy',
      required: false,
      type: 'text',
      unique: false,
    });
    const record = await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId: tableId,
      values: { legacy: 'missing' },
    });
    const convert = (actorId: string, defaultValue: string, recordValue: string) =>
      value.app.executeAction(actorId, 'cli', 'table.field.convert', {
        channelId: tableId,
        defaultResolution: { kind: 'map', value: defaultValue },
        fieldId: field.subject!.id,
        observedVersion: 1,
        resolutions: [{ kind: 'map', recordId: record.subject!.id, value: recordValue }],
        targetChannelId: dictionaryId,
        targetType: 'dictionary',
      });

    await expect(convert(value.owner.id, 'missing-entry', entryId)).rejects.toMatchObject({
      code: 'table.field-conversion-resolution-invalid',
    } satisfies Partial<DatagramError>);
    await expect(convert(value.owner.id, retired.subject!.id, entryId)).rejects.toMatchObject({
      code: 'table.field-conversion-resolution-invalid',
    } satisfies Partial<DatagramError>);
    await expect(convert(value.owner.id, otherEntryId, entryId)).rejects.toMatchObject({
      code: 'table.field-conversion-resolution-invalid',
    } satisfies Partial<DatagramError>);

    const admin = await value.app.executeAction(
      value.owner.id,
      'cli',
      'service.person.create',
      { displayName: 'Table-only Admin' },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: tableId,
      personId: admin.subject!.id,
      role: 'admin',
    });
    await expect(convert(admin.subject!.id, entryId, entryId)).rejects.toMatchObject({
      code: 'permission.denied',
    } satisfies Partial<DatagramError>);

    await convert(value.owner.id, entryId, entryId);
    expect(
      (await value.store.listTableFields(tableId)).find(
        (candidate) => candidate.id === field.subject!.id,
      ),
    ).toMatchObject({
      defaultValue: entryId,
      targetChannelId: dictionaryId,
      type: 'dictionary',
      version: 2,
    });
    expect(await value.store.getTableRecord(record.subject!.id)).toMatchObject({
      values: { legacy: entryId },
    });
  });

  test('keeps retired references through Field restore, unrelated conversion, and undo', async () => {
    const { dictionaryId, entryId, tableId, value } = await setup();
    const dictionaryField = await addDictionaryField(value, tableId, dictionaryId);
    const spareField = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.field.add',
      {
        channelId: tableId,
        key: 'spare',
        label: 'Spare',
        required: false,
        type: 'text',
        unique: false,
      },
    );
    const record = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.record.create',
      { channelId: tableId, values: { product: entryId } },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'dictionary.entry.retire', {
      channelId: dictionaryId,
      entryId,
    });

    await value.app.executeAction(value.owner.id, 'cli', 'table.field.tombstone', {
      channelId: tableId,
      fieldId: dictionaryField.subject!.id,
      observedVersion: 1,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.restore', {
      channelId: tableId,
      fieldId: dictionaryField.subject!.id,
      observedVersion: 2,
    });
    const converted = await value.app.executeAction(
      value.owner.id,
      'cli',
      'table.field.convert',
      {
        channelId: tableId,
        fieldId: spareField.subject!.id,
        observedVersion: 1,
        targetType: 'boolean',
      },
    );
    await value.app.executeAction(value.owner.id, 'cli', 'operation.undo', {
      channelId: tableId,
      operationId: converted.operationId,
    });

    expect(await value.store.getTableRecord(record.subject!.id)).toMatchObject({
      values: { product: entryId },
    });
    const restoredField = (await value.store.listTableFields(tableId)).find(
      (field) => field.id === dictionaryField.subject!.id,
    );
    expect(restoredField).toMatchObject({ type: 'dictionary', version: 3 });
    expect(restoredField?.tombstonedAt).toBeUndefined();
  });
});
