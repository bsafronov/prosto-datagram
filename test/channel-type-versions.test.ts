import { afterEach, describe, expect, test } from 'bun:test';
import * as z from 'zod/v4';

import { DatagramError } from '../src/packages/application/errors';
import { createDatagramApplication, DatagramApplication } from '../src/packages/application';
import {
  bundledChannelTypes,
  ChannelTypeRegistry,
  type ChannelViewDeclaration,
  type ChannelViewInput,
} from '../src/packages/domain/channel-types';
import type { Channel, ChartDefinition, DictionaryEntry, Message, Operation, QueryResult, TableField, TableRecord } from '../src/packages/domain/model';
import { SqliteStore } from '../src/packages/sqlite-store';

const stores: SqliteStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe('Channel Type version pinning', () => {
  test('keeps bundled contract behavior out of the application registry', async () => {
    const applicationSource = await Bun.file(
      new URL('../src/packages/application/lib/datagram.ts', import.meta.url),
    ).text();
    const tableSource = await Bun.file(
      new URL('../src/packages/domain/lib/channel-type-modules/table.ts', import.meta.url),
    ).text();
    expect(applicationSource).not.toContain('#typeActions');
    expect(applicationSource).not.toContain('#typeQueries');
    expect(applicationSource).not.toMatch(/name:\s*'(?:chart|dictionary|discussion|table)\./);
    expect(applicationSource).not.toContain('operationBuilders');
    expect(tableSource).not.toContain('issuedConversionPlans');
    const fieldUpdatePort = applicationSource.slice(
      applicationSource.indexOf('updateTableField: async'),
      applicationSource.indexOf('updateTableRecord: queueTableRecordUpdate'),
    );
    for (const conversionRule of [
      'table.field-reference-configuration',
      'table.field-dictionary-configuration',
      'table.field-conversion-default-unresolved',
      'table.field-conversion-resolution-invalid',
      'table.field-conversion-unresolved',
    ]) expect(fieldUpdatePort).not.toContain(conversionRule);
    expect(tableSource.match(/capabilities\.state!\.planTableFieldConversion/g)).toHaveLength(2);
    for (const definition of bundledChannelTypes) {
      for (const contract of [...definition.actions, ...definition.queries]) {
        expect(typeof contract.execute).toBe('function');
        expect(contract.execute.toString()).not.toContain('capabilities.actions');
        expect(contract.execute.toString()).not.toContain('capabilities.queries');
      }
    }
  });

  test('selects definitions by immutable id and version', () => {
    const table = bundledChannelTypes.find((definition) => definition.id === 'table')!;
    const next = { ...table, title: 'Table v2', version: '2.0.0' };
    const registry = new ChannelTypeRegistry([next, table]);

    expect(registry.require('table', '1.0.0').title).toBe('Table');
    expect(registry.require('table', '2.0.0').title).toBe('Table v2');
    expect(registry.requireCurrent('table').version).toBe('2.0.0');
    expect(() => registry.require('table', '3.0.0')).toThrow(
      expect.objectContaining({ code: 'channel-type.version-unavailable' }),
    );
    expect(() => new ChannelTypeRegistry([table, table])).toThrow(
      expect.objectContaining({ code: 'channel-type.duplicate' }),
    );
  });

  test('pins Field conversion planning and sealing to the exact installed version', async () => {
    const table = bundledChannelTypes.find((definition) => definition.id === 'table')!;
    const tableV2 = {
      ...table,
      planTableFieldConversion: async (
        input: Parameters<NonNullable<typeof table.planTableFieldConversion>>[0],
        state: Parameters<NonNullable<typeof table.planTableFieldConversion>>[1],
        seal: Parameters<NonNullable<typeof table.planTableFieldConversion>>[2],
      ) => {
        const field = (await state.tableFields()).find((candidate) => candidate.id === input.fieldId)!;
        const nextField = {
          ...field,
          defaultValue: 42,
          type: input.targetType,
          version: field.version + 1,
        };
        return seal({
          field: nextField,
          previousField: field,
          preview: {
            defaultFailure: 'v2-only',
            failures: [],
            fieldId: field.id,
            observedVersion: field.version,
            targetType: input.targetType,
          },
          purpose: input.resolutions === undefined ? 'preview' : 'execute',
          recordUpdates: [],
        }, field.id, field.version);
      },
      title: 'Table v2',
      version: '2.0.0',
    };
    const registry = new ChannelTypeRegistry([table, tableV2]);
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    const app = new DatagramApplication(store, registry);
    const create = async (version: string) => (await app.executeAction(owner.id, 'cli', 'channel.create', {
      title: `Table ${version}`,
      typeId: 'table',
      typeVersion: version,
    })).subject!.id;
    const v1ChannelId = await create('1.0.0');
    const v2ChannelId = await create('2.0.0');
    const add = async (channelId: string) => (await app.executeAction(owner.id, 'cli', 'table.field.add', {
      channelId,
      key: 'legacy',
      label: 'Legacy',
      required: false,
      type: 'text',
      unique: false,
    })).subject!.id;
    const v1FieldId = await add(v1ChannelId);
    const v2FieldId = await add(v2ChannelId);
    const preview = async (channelId: string, fieldId: string) => app.executeQuery(owner.id, 'cli', 'table.field.conversion.preview', {
      channelId,
      fieldId,
      targetType: 'number',
    });
    expect((await preview(v1ChannelId, v1FieldId)).data).toMatchObject({ defaultFailure: null });
    expect((await preview(v2ChannelId, v2FieldId)).data).toMatchObject({ defaultFailure: 'v2-only' });
    for (const [channelId, fieldId] of [[v1ChannelId, v1FieldId], [v2ChannelId, v2FieldId]]) {
      await app.executeAction(owner.id, 'cli', 'table.field.convert', {
        channelId,
        fieldId,
        observedVersion: 1,
        targetType: 'number',
      });
    }
    expect((await store.listTableFields(v1ChannelId))[0]).not.toHaveProperty('defaultValue');
    expect((await store.listTableFields(v2ChannelId))[0]).toMatchObject({ defaultValue: 42, type: 'number' });

    const mockField = { ...(await store.listTableFields(v2ChannelId))[0]!, id: 'mock-field', type: 'text' as const, version: 1 };
    const binding = { actorId: owner.id, channelId: v2ChannelId, serviceId: 'service-test' };
    const crossVersionPlan = await registry.planTableFieldConversion('table', '2.0.0', binding, {
      fieldId: mockField.id,
      observedVersion: 1,
      resolutions: [],
      targetType: 'number',
    }, {
      channel: (await store.getChannel(v2ChannelId))!,
      tableFields: async () => [mockField],
    } as any);
    expect(() => registry.consumeTableFieldConversionPlan('table', '1.0.0', crossVersionPlan, binding))
      .toThrowError(expect.objectContaining({ code: 'channel-type.capability-denied' }));
  });

  test('rejects sealed plans that smuggle Field or Record state', async () => {
    const table = bundledChannelTypes.find((definition) => definition.id === 'table')!;
    let substituteFieldId = '';
    const maliciousV2 = {
      ...table,
      planTableFieldConversion: async (
        input: Parameters<NonNullable<typeof table.planTableFieldConversion>>[0],
        state: Parameters<NonNullable<typeof table.planTableFieldConversion>>[1],
        seal: Parameters<NonNullable<typeof table.planTableFieldConversion>>[2],
      ) => {
        const field = (await state.tableFields()).find((candidate) => candidate.id === input.fieldId)!;
        let nextField: TableField = { ...field, type: input.targetType, version: field.version + 1 };
        if (field.key === 'field_identity') nextField = { ...nextField, id: substituteFieldId };
        if (field.key === 'field_shape') nextField = { ...nextField, key: 'stolen', required: true, unique: true };
        if (field.key === 'field_version') nextField = { ...nextField, version: field.version + 2 };
        const records = await state.tableRecords();
        const previousRecord = records[0]!;
        let recordUpdates: { previousRecord: TableRecord; record: TableRecord }[] = [];
        if (field.key.startsWith('record_')) {
          let record: TableRecord = {
            ...previousRecord,
            fieldVersions: { ...previousRecord.fieldVersions, [field.key]: (previousRecord.fieldVersions[field.key] ?? 0) + 1 },
            values: { ...previousRecord.values, [field.key]: 1 },
          };
          if (field.key === 'record_identity') record = { ...record, id: 'record-stolen' };
          if (field.key === 'record_scope') record = { ...record, channelId: 'channel-stolen' };
          if (field.key === 'record_value') record = { ...record, values: { ...record.values, untouched: 'stolen' } };
          if (field.key === 'record_history') record = { ...record, fieldVersions: { ...record.fieldVersions, [field.key]: (previousRecord.fieldVersions[field.key] ?? 0) + 2 } };
          recordUpdates = [{ previousRecord, record }];
        }
        return seal({
          field: nextField,
          previousField: field,
          preview: { defaultFailure: null, failures: [], fieldId: field.id, observedVersion: field.version, targetType: input.targetType },
          purpose: 'execute',
          recordUpdates,
        }, field.id, field.version);
      },
      title: 'Malicious Table v2',
      version: '2.0.0',
    };
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    const app = new DatagramApplication(store, new ChannelTypeRegistry([maliciousV2]));
    const channelId = (await app.executeAction(owner.id, 'cli', 'channel.create', {
      title: 'Malicious Table',
      typeId: 'table',
      typeVersion: '2.0.0',
    })).subject!.id;
    const keys = ['field_identity', 'field_shape', 'field_version', 'record_identity', 'record_scope', 'record_value', 'record_history'];
    const fieldIds = new Map<string, string>();
    for (const key of [...keys, 'substitute', 'untouched']) {
      const receipt = await app.executeAction(owner.id, 'cli', 'table.field.add', {
        channelId,
        key,
        label: key,
        required: false,
        type: 'text',
        unique: false,
      });
      fieldIds.set(key, receipt.subject!.id);
    }
    substituteFieldId = fieldIds.get('substitute')!;
    const record = await app.executeAction(owner.id, 'cli', 'table.record.create', {
      channelId,
      values: Object.fromEntries([...keys, 'untouched'].map((key) => [key, 'original'])),
    });
    const before = (await store.listOperations(channelId)).length;
    for (const key of keys) {
      await expect(app.executeAction(owner.id, 'cli', 'table.field.convert', {
        channelId,
        fieldId: fieldIds.get(key),
        observedVersion: 1,
        targetType: 'number',
      })).rejects.toMatchObject({ code: 'channel-type.capability-denied' });
    }
    expect(await store.listOperations(channelId)).toHaveLength(before);
    expect(await store.getTableRecord(record.subject!.id)).toMatchObject({ values: { untouched: 'original' } });
    for (const key of keys) expect((await store.listTableFields(channelId)).find((field) => field.key === key)).toMatchObject({ type: 'text', version: 1 });
  });

  test('bundled modules own typed contracts, rules, and semantic views', () => {
    for (const definition of bundledChannelTypes) {
      expect(definition.actions.length).toBeGreaterThan(0);
      expect(definition.queries.length).toBeGreaterThan(0);
      expect(definition.recordKinds.length).toBeGreaterThan(0);
      expect(definition.stateRules.length).toBeGreaterThan(0);
      for (const contract of [...definition.actions, ...definition.queries]) {
        expect(typeof contract.inputSchema.parse).toBe('function');
      }
      for (const query of definition.queries) {
        expect(definition.views.some((view) => view.query === query.name)).toBeTrue();
      }
      for (const view of definition.views) expect(typeof view.produce).toBe('function');
    }
  });

  test('deep-freezes metadata and exposes isolated real Zod schemas', () => {
    const registry = new ChannelTypeRegistry(bundledChannelTypes);
    const definition = registry.require('table', '1.0.0');
    expect(Object.isFrozen(definition)).toBeTrue();
    expect(Object.isFrozen(definition.actions)).toBeTrue();
    expect(Object.isFrozen(definition.actions[0])).toBeTrue();
    expect(z.toJSONSchema(definition.actions[0]!.inputSchema)).toMatchObject({ type: 'object' });
    expect(definition.actions[0]!.inputSchema).not.toBe(definition.actions[0]!.inputSchema);
    expect(Object.isFrozen(definition.views)).toBeTrue();
    expect(Object.isFrozen(definition.views[0])).toBeTrue();
    expect(Object.isFrozen(definition.views[0]!.commands)).toBeTrue();
    expect(() => definition.views[0]!.commands.push('mutated')).toThrow();
  });

  test('snapshots caller schemas and isolates schemas returned to consumers', () => {
    const source = z.object({ channelId: z.string(), value: z.string() });
    const registry = new ChannelTypeRegistry([
      {
        actions: [{
          allowedOperations: [],
          authorization: { kind: 'channel-role', minimumRole: 'contributor' },
          execute: async () => { throw new Error('not invoked'); },
          inputSchema: source,
          name: 'custom.write',
        }],
        activityFor: () => undefined,
        activityKinds: [],
        id: 'custom',
        queries: [],
        recordKinds: [],
        stateRules: [],
        title: 'Custom',
        version: '1.0.0',
        views: [],
      },
    ]);
    source.shape.value = z.number() as never;
    expect(registry.requireAction('custom', '1.0.0', 'custom.write')!.parse({
      channelId: 'channel',
      value: 'stable',
    })).toEqual({ channelId: 'channel', value: 'stable' });

    const exposed = registry.requireAction('custom', '1.0.0', 'custom.write')! as z.ZodObject;
    exposed.shape.value = z.number();
    expect(registry.requireAction('custom', '1.0.0', 'custom.write')!.safeParse({
      channelId: 'channel',
      value: 'still-stable',
    }).success).toBeTrue();
  });

  test('binds every mutation capability to its selected aggregate', async () => {
    let foreignEntry!: DictionaryEntry;
    let foreignMessage!: Message;
    let foreignField!: TableField;
    let foreignRecord!: TableRecord;
    let foreignChart!: ChartDefinition;
    const malicious = (name: string, allowedOperations: any[], execute: any) => ({
      allowedOperations,
      authorization: { kind: 'channel-role' as const, minimumRole: 'owner' as const },
      execute,
      inputSchema: z.object({ channelId: z.string().min(1) }),
      name,
    });
    const definitions = bundledChannelTypes.map((definition) => {
      if (definition.id === 'dictionary') return {
        ...definition,
        actions: [...definition.actions,
          malicious('dictionary.attack.entry', ['renameDictionaryEntry'], async (_input: unknown, capabilities: any) => {
            await capabilities.changes.renameDictionaryEntry({ entryId: foreignEntry.id, label: 'stolen', normalizedLabel: 'stolen', updatedAt: capabilities.now() });
            return capabilities.commit();
          }),
          malicious('dictionary.attack.message', ['editDiscussionMessage'], async (_input: unknown, capabilities: any) => {
            await capabilities.changes.editDiscussionMessage(foreignMessage.id, 'stolen');
            return capabilities.commit();
          }),
        ],
      };
      if (definition.id === 'table') return {
        ...definition,
        actions: [...definition.actions,
          malicious('table.attack.field', ['updateTableField'], async (_input: unknown, capabilities: any) => {
            await capabilities.changes.updateTableField({ ...foreignField, label: 'stolen', version: foreignField.version + 1 }, foreignField);
            return capabilities.commit();
          }),
          malicious('table.attack.record', ['updateTableRecord'], async (_input: unknown, capabilities: any) => {
            await capabilities.changes.updateTableRecord({ observedVersions: {}, recordId: foreignRecord.id, values: {} });
            return capabilities.commit();
          }),
          malicious('table.attack.view', ['createTableView'], async (_input: unknown, capabilities: any) => {
            await capabilities.changes.createTableView({ filters: [], grouping: [], name: 'Scoped', sorting: [], visibility: 'personal', visibleFieldIds: [] });
            return capabilities.commit();
          }),
        ],
      };
      if (definition.id === 'chart') return {
        ...definition,
        actions: [...definition.actions,
          malicious('chart.attack.definition', ['setChartDefinition'], async (_input: unknown, capabilities: any) => {
            await capabilities.changes.setChartDefinition({ ...foreignChart, version: foreignChart.version + 1 }, foreignChart.version);
            return capabilities.commit();
          }),
        ],
      };
      return definition;
    });
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    const app = new DatagramApplication(store, new ChannelTypeRegistry(definitions));
    const create = async (typeId: 'dictionary' | 'table') => (await app.executeAction(owner.id, 'cli', 'channel.create', { title: typeId, typeId })).subject!.id;
    const dictionaryA = await create('dictionary');
    const dictionaryB = await create('dictionary');
    const tableA = await create('table');
    const tableB = await create('table');
    const entry = await app.executeAction(owner.id, 'cli', 'dictionary.entry.create', { channelId: dictionaryB, label: 'Foreign' });
    foreignEntry = (await store.getDictionaryEntry(entry.subject!.id))!;
    const message = await app.executeAction(owner.id, 'cli', 'discussion.message.post', { channelId: dictionaryB, text: 'Foreign' });
    foreignMessage = (await store.getMessage(message.subject!.id))!;
    const field = await app.executeAction(owner.id, 'cli', 'table.field.add', { channelId: tableB, key: 'name', label: 'Name', required: false, type: 'text', unique: false });
    foreignField = (await store.listTableFields(tableB)).find((item) => item.id === field.subject!.id)!;
    const record = await app.executeAction(owner.id, 'cli', 'table.record.create', { channelId: tableB, values: {} });
    foreignRecord = (await store.getTableRecord(record.subject!.id))!;
    const now = new Date().toISOString();
    const chartA = 'chart-a';
    const chartB = 'chart-b';
    foreignChart = { aggregations: [{ as: 'count', operator: 'count' }], channelId: chartB, filters: [], grouping: [], presentation: { series: ['count'], type: 'bar' }, sourceChannelId: tableB, version: 1 };
    for (const channelId of [chartA, chartB]) await store.commit({
      action: 'test.seed', actorId: owner.id, channelId, id: `seed-${channelId}`, intent: 'test.seed', occurredAt: now, origin: 'cli', result: { status: 'succeeded' }, status: 'succeeded',
      changes: [
        { channel: { createdAt: now, id: channelId, ownerId: owner.id, title: channelId, typeId: 'chart', typeVersion: '1.0.0', updatedAt: now }, kind: 'channel.created' },
        { kind: 'membership.granted', membership: { channelId, personId: owner.id, role: 'owner' } },
        { definition: { ...foreignChart, channelId }, kind: 'chart.definition-set' },
      ],
    });
    for (const [action, channelId] of [
      ['dictionary.attack.entry', dictionaryA], ['dictionary.attack.message', dictionaryA],
      ['table.attack.field', tableA], ['table.attack.record', tableA],
      ['chart.attack.definition', chartA],
    ] as const) {
      const before = (await store.listOperations(channelId)).length;
      await expect(app.executeAction(owner.id, 'cli', action, { channelId })).rejects.toBeDefined();
      expect(await store.listOperations(channelId)).toHaveLength(before);
    }
    await app.executeAction(owner.id, 'cli', 'table.attack.view', { channelId: tableA });
    expect(await store.listTableViews(tableA, owner.id)).toHaveLength(1);
    expect(await store.listTableViews(tableB, owner.id)).toHaveLength(0);
  });

  test('re-authorizes actual Message targets selected by a type handler', async () => {
    let victimMessageId = '';
    const attack = (name: string, operation: string, execute: (capabilities: any) => Promise<void>) => ({
      allowedOperations: [operation as any],
      authorization: { kind: 'message-author-or-admin' as const },
      execute: async (_input: unknown, capabilities: any) => {
        await execute(capabilities);
        return capabilities.commit();
      },
      inputSchema: z.object({ channelId: z.string(), messageId: z.string() }),
      name,
    });
    const definitions = bundledChannelTypes.map((definition) => definition.id === 'dictionary' ? {
      ...definition,
      actions: [...definition.actions,
        attack('discussion.attack.edit', 'editDiscussionMessage', (capabilities) => capabilities.changes.editDiscussionMessage(victimMessageId, 'forged')),
        attack('discussion.attack.tombstone', 'tombstoneDiscussionMessage', (capabilities) => capabilities.changes.tombstoneDiscussionMessage(victimMessageId)),
        attack('discussion.attack.restore', 'restoreDiscussionMessage', (capabilities) => capabilities.changes.restoreDiscussionMessage(victimMessageId)),
      ],
    } : definition);
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    const app = new DatagramApplication(store, new ChannelTypeRegistry(definitions));
    const attacker = (await app.executeAction(owner.id, 'cli', 'service.person.create', { displayName: 'Attacker' })).subject!.id;
    const channelId = (await app.executeAction(owner.id, 'cli', 'channel.create', { title: 'Messages', typeId: 'dictionary' })).subject!.id;
    await app.executeAction(owner.id, 'cli', 'channel.member.grant', { channelId, personId: attacker, role: 'contributor' });
    victimMessageId = (await app.executeAction(owner.id, 'cli', 'discussion.message.post', { channelId, text: 'Victim' })).subject!.id;
    const ownMessageId = (await app.executeAction(attacker, 'cli', 'discussion.message.post', { channelId, text: 'Own' })).subject!.id;
    for (const name of ['discussion.attack.edit', 'discussion.attack.tombstone']) {
      await expect(app.executeAction(attacker, 'cli', name, { channelId, messageId: ownMessageId }))
        .rejects.toMatchObject({ code: 'permission.denied' });
    }
    expect(await store.getMessage(victimMessageId)).toMatchObject({ text: 'Victim' });
    expect((await store.getMessage(victimMessageId))?.tombstonedAt).toBeUndefined();
    await app.executeAction(owner.id, 'cli', 'discussion.message.tombstone', { channelId, messageId: victimMessageId });
    await expect(app.executeAction(attacker, 'cli', 'discussion.attack.restore', { channelId, messageId: ownMessageId }))
      .rejects.toMatchObject({ code: 'permission.denied' });
    expect((await store.getMessage(victimMessageId))?.tombstonedAt).toBeDefined();
  });

  test('derives Field purge and Record update transitions from canonical state', async () => {
    let fieldId = '';
    let keepFieldId = '';
    let recordId = '';
    const definitions = bundledChannelTypes.map((definition) => definition.id === 'table' ? {
      ...definition,
      actions: [...definition.actions, {
        allowedOperations: ['updateTableRecord' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'owner' as const },
        execute: async (_input: unknown, capabilities: any) => {
          await capabilities.changes.updateTableRecord({ observedVersions: { score: 1 }, recordId, values: { score: 'invalid' } });
          return capabilities.commit();
        },
        inputSchema: z.object({ channelId: z.string() }),
        name: 'table.attack.invalid-record',
      }, {
        allowedOperations: ['updateTableField' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'owner' as const },
        execute: async (_input: unknown, capabilities: any) => {
          await capabilities.changes.updateTableField({ fieldId, kind: 'tombstone', observedVersion: 999 });
          return capabilities.commit();
        },
        inputSchema: z.object({ channelId: z.string() }),
        name: 'table.attack.field-version',
      }, {
        allowedOperations: ['updateTableField' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'owner' as const },
        execute: async (_input: unknown, capabilities: any) => {
          await capabilities.changes.updateTableField({ fieldId, kind: 'restore', observedVersion: 1 });
          return capabilities.commit();
        },
        inputSchema: z.object({ channelId: z.string() }),
        name: 'table.attack.field-undo',
      }, {
        allowedOperations: ['updateTableField' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'owner' as const },
        execute: async (_input: unknown, capabilities: any) => {
          const previewPlan = await capabilities.state.planTableFieldConversion({
            fieldId: keepFieldId,
            observedVersion: 1,
            targetType: 'number',
          });
          await capabilities.changes.updateTableField({ kind: 'convert', plan: previewPlan });
          return capabilities.commit();
        },
        inputSchema: z.object({ channelId: z.string() }),
        name: 'table.attack.field-schema',
      }, {
        allowedOperations: ['purgeTableField' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'owner' as const },
        execute: async (_input: unknown, capabilities: any) => {
          await capabilities.changes.purgeTableField(fieldId, { fieldKey: 'keep', version: -1 });
          return capabilities.commit();
        },
        inputSchema: z.object({ channelId: z.string() }),
        name: 'table.attack.purge',
      }],
    } : definition);
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    const app = new DatagramApplication(store, new ChannelTypeRegistry(definitions));
    const channelId = (await app.executeAction(owner.id, 'cli', 'channel.create', { title: 'Table', typeId: 'table' })).subject!.id;
    fieldId = (await app.executeAction(owner.id, 'cli', 'table.field.add', { channelId, key: 'score', label: 'Score', required: false, type: 'number', unique: false })).subject!.id;
    keepFieldId = (await app.executeAction(owner.id, 'cli', 'table.field.add', { channelId, key: 'keep', label: 'Keep', required: false, type: 'text', unique: false })).subject!.id;
    recordId = (await app.executeAction(owner.id, 'cli', 'table.record.create', { channelId, values: { keep: 'safe', score: 5 } })).subject!.id;
    const before = (await store.listOperations(channelId)).length;
    await expect(app.executeAction(owner.id, 'cli', 'table.attack.invalid-record', { channelId }))
      .rejects.toMatchObject({ code: 'table.field-type' });
    for (const [action, code] of [
      ['table.attack.field-version', 'table.field-conflict'],
      ['table.attack.field-undo', 'table.field-not-tombstoned'],
      ['table.attack.field-schema', 'channel-type.capability-denied'],
    ] as const) {
      await expect(app.executeAction(owner.id, 'cli', action, { channelId })).rejects.toMatchObject({ code });
    }
    expect(await store.listOperations(channelId)).toHaveLength(before);
    expect((await store.getTableRecord(recordId))?.values).toEqual({ keep: 'safe', score: 5 });
    await app.executeAction(owner.id, 'cli', 'table.field.tombstone', { channelId, fieldId, observedVersion: 1 });
    await app.executeAction(owner.id, 'cli', 'table.attack.purge', { channelId });
    expect((await store.getTableRecord(recordId))?.values).toEqual({ keep: 'safe' });
    expect((await store.listTableFields(channelId)).some((field) => field.id === fieldId)).toBeFalse();
  });

  test('discovers and executes exact contracts for pinned versions', async () => {
    const table = bundledChannelTypes.find((definition) => definition.id === 'table')!;
    const chart = bundledChannelTypes.find((definition) => definition.id === 'chart')!;
    const chartV1 = {
      ...chart,
      actions: chart.actions.map((action) => action.name === 'chart.create' ? {
        ...action,
        execute: async (
          input: {
            handleId: string;
            presentation: { series: string[]; type: 'bar' | 'line' | 'pie' };
            title: string;
            typeVersion?: string;
          },
          capabilities: Parameters<typeof action.execute>[1],
        ) => {
          if (input.title !== 'Selected pinned chart' || !('changes' in capabilities)) {
            return action.execute(input, capabilities);
          }
          if (input.typeVersion !== '1.0.0') throw new Error('Pinned Chart version was not injected');
          await capabilities.changes.createChart!();
          return capabilities.commit();
        },
      } : action),
      queries: chart.queries.map((query) => query.name === 'chart.open' ? {
        ...query,
        execute: async (_input: unknown, capabilities: Parameters<typeof query.execute>[1]) => {
          if (!('read' in capabilities) || !capabilities.readSourceTable) throw new Error('Chart source capability required');
          return (capabilities.readSourceTable as (...args: unknown[]) => Promise<QueryResult>)('table-v2');
        },
      } : query),
    };
    const chartV2 = { ...chart, title: 'Chart v2', version: '2.0.0' };
    const v2 = {
      ...table,
      actions: [...table.actions.map((action) =>
        action.name === 'channel.create'
          ? {
              ...action,
              execute: async (
                input: { title: string; typeId: string; typeVersion?: string },
                capabilities: Parameters<typeof action.execute>[1],
              ) => {
                if (input.title !== 'Owned v1 creation' || !('changes' in capabilities)) {
                  return action.execute(input, capabilities);
                }
                capabilities.changes.createChannel!(input.title);
                return capabilities.commit();
              },
            }
          : action.name === 'table.record.create'
          ? {
              ...action,
              inputSchema: z.object({
                channelId: z.string().min(1),
                mode: z.literal('v2').optional(),
                values: z.record(z.string(), z.unknown()),
              }),
            }
          : action.name === 'table.view.create'
            ? {
                ...action,
                execute: async (
                  input: {
                    channelId: string;
                    filters: [];
                    grouping: [];
                    name: string;
                    sorting: [];
                    visibility: 'personal' | 'shared';
                    visibleFieldIds: string[];
                  },
                  capabilities: Parameters<typeof action.execute>[1],
                ) => {
                  if (input.name !== 'Scoped viewer view' || !('changes' in capabilities)) {
                    return action.execute(input, capabilities);
                  }
                  expect(capabilities.changes.setTableDisplayField).toBeUndefined();
                  expect(capabilities.changes.createTableRecord).toBeUndefined();
                  await capabilities.changes.createTableView!({
                    filters: input.filters,
                    grouping: input.grouping,
                    name: input.name,
                    sorting: input.sorting,
                    visibility: input.visibility,
                    visibleFieldIds: input.visibleFieldIds,
                  });
                  return capabilities.commit();
                },
              }
          : action.name === 'table.display-field.set'
            ? {
                ...action,
                execute: async (
                  input: { channelId: string; fieldId: string | null },
                  capabilities: Parameters<typeof action.execute>[1],
                ) => {
                  if (input.fieldId !== 'v2-default' || !('commit' in capabilities)) {
                    return action.execute(input, capabilities);
                  }
                  await capabilities.changes.setTableDisplayField!(null);
                  return capabilities.commit();
                },
              }
          : action,
      ), {
        allowedOperations: ['setTableDisplayField' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'admin' as const },
        execute: async (
          input: { channelId: string },
          capabilities: Parameters<(typeof table.actions)[number]['execute']>[1],
        ) => {
          if (!('changes' in capabilities)) throw new Error('Action capabilities required');
          expect(Object.isFrozen(input)).toBeTrue();
          expect(Reflect.set(input, 'channelId', 'table-v1')).toBeFalse();
          expect(input.channelId).toBe('table-v2');
          await capabilities.changes.setTableDisplayField!(null);
          return capabilities.commit();
        },
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.custom.reset-display',
      }],
      queries: [...table.queries.map((query) =>
        query.name === 'table.configuration'
          ? {
              ...query,
              execute: async (
                input: { channelId: string; edition: 'v2' },
                capabilities: Parameters<typeof query.execute>[1],
              ) => {
                if (!('read' in capabilities)) throw new Error('Query capabilities required');
                const result = await query.execute({ channelId: input.channelId }, capabilities);
                return {
                  ...result,
                  data: { ...(result.data as Record<string, unknown>), edition: 'v2' },
                };
              },
              inputSchema: z.object({
                channelId: z.string().min(1),
                edition: z.literal('v2'),
              }),
            }
          : query,
      ), {
        allowedOperations: [],
        authorization: { kind: 'channel-role' as const, minimumRole: 'viewer' as const },
        execute: async (
          input: { channelId: string },
          capabilities: Parameters<(typeof table.queries)[number]['execute']>[1],
        ) => {
          if (!('read' in capabilities)) throw new Error('Query capabilities required');
          const result = await capabilities.read('table.configuration', {
            channelId: input.channelId,
            edition: 'v2',
          });
          return { ...result, data: { mediated: true, source: result.data } };
        },
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.custom.configuration',
      }, {
        allowedOperations: [],
        authorization: { kind: 'operator' as const },
        execute: async (_input: unknown, capabilities: Parameters<(typeof table.queries)[number]['execute']>[1]) => {
          if (!('read' in capabilities)) throw new Error('Query capabilities required');
          expect(capabilities.readSourceTable).toBeUndefined();
          return {
            data: { status: 'ready' },
            view: {
              bindings: { status: '$result' },
              commands: [],
              kind: 'operator-status',
              schemaVersion: 'datagram/view@1' as const,
              title: 'Operator Status',
            },
          };
        },
        inputSchema: z.object({}),
        name: 'table.custom.operator-status',
      }],
      title: 'Table v2',
      version: '2.0.0',
      stateRules: [
        ...table.stateRules,
        {
          name: 'v2-record-mode',
          validate: (contract: string, input: unknown) => {
            if (
              contract === 'table.record.create' &&
              (input as { mode?: unknown }).mode !== 'v2'
            ) throw new Error('Table v2 record mode is required');
          },
        },
      ],
      views: [...table.views.map((view) =>
        view.query === 'table.configuration'
          ? {
              ...view,
              commands: [],
              kind: 'table-configuration-v2',
              produce: (_input: ChannelViewInput, declaration: ChannelViewDeclaration) => ({
                bindings: declaration.bindings,
                commands: [],
                kind: 'table-configuration-v2',
                schemaVersion: 'datagram/view@1' as const,
                title: 'Table Configuration v2',
              }),
            }
          : view,
      ), {
        bindings: { configuration: '$result' },
        commands: [],
        kind: 'table-custom-configuration',
        produce: (_input: ChannelViewInput, declaration: ChannelViewDeclaration) => ({
          bindings: declaration.bindings,
          commands: [],
          kind: 'table-custom-configuration',
          schemaVersion: 'datagram/view@1' as const,
          title: 'Custom configuration',
        }),
        query: 'table.custom.configuration',
        title: 'Custom configuration',
      }, {
        bindings: { status: '$result' },
        commands: [],
        kind: 'operator-status',
        produce: (_input: ChannelViewInput, declaration: ChannelViewDeclaration) => ({
          bindings: declaration.bindings,
          commands: [],
          kind: declaration.kind,
          schemaVersion: 'datagram/view@1' as const,
          title: 'Operator Status',
        }),
        query: 'table.custom.operator-status',
        title: 'Operator Status',
      }],
    };
    const registry = new ChannelTypeRegistry([
      ...bundledChannelTypes.filter((definition) => definition.id !== 'table' && definition.id !== 'chart'),
      chartV1,
      chartV2,
      table,
      v2,
    ]);
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    for (const [id, version] of [['table-v1', '1.0.0'], ['table-v2', '2.0.0']] as const) {
      const channel: Channel = {
        createdAt: new Date().toISOString(),
        id,
        ownerId: owner.id,
        title: id,
        typeId: 'table',
        typeVersion: version,
        updatedAt: new Date().toISOString(),
      };
      await store.commit({
        action: 'test.seed',
        actorId: owner.id,
        changes: [
          { channel, kind: 'channel.created' },
          { kind: 'membership.granted', membership: { channelId: id, personId: owner.id, role: 'owner' } },
        ],
        channelId: id,
        id: `seed-${id}`,
        intent: 'test.seed',
        occurredAt: new Date().toISOString(),
        origin: 'cli',
        result: { status: 'succeeded' },
        status: 'succeeded',
      });
    }
    const app = new DatagramApplication(store, registry);
    const v1Record = await app.executeAction(owner.id, 'cli', 'table.record.create', { channelId: 'table-v1', values: {} });
    const v2Record = await app.executeAction(owner.id, 'cli', 'table.record.create', { channelId: 'table-v2', mode: 'v2', values: {} });
    const selectedCreation = await app.executeAction(
      owner.id,
      'cli',
      'channel.create',
      { title: 'Owned v1 creation', typeId: 'table' },
      { typeId: 'table', typeVersion: '1.0.0' },
    );
    expect(await store.getChannel(selectedCreation.subject!.id)).toMatchObject({
      typeId: 'table',
      typeVersion: '1.0.0',
    });
    const ownedCreation = await app.executeAction(
      owner.id,
      'cli',
      'channel.create',
      { title: 'Owned v1 creation', typeId: 'table' },
      { typeId: 'table', typeVersion: '2.0.0' },
    );
    expect(await store.getChannel(ownedCreation.subject!.id)).toMatchObject({
      ownerId: owner.id,
      typeId: 'table',
      typeVersion: '2.0.0',
    });
    const sourceHandle = await app.prepareQuery(
      owner.id,
      'agent',
      'table.records.list',
      { channelId: 'table-v1' },
      'chart.aggregate',
    );
    const chartHandle = await app.composeResultHandle(owner.id, {
      handleId: sourceHandle.id,
      inputPurpose: 'chart.aggregate',
      outputPurpose: 'chart.create',
      transform: { aggregations: [{ as: 'count', operator: 'count' }], kind: 'aggregate' },
    });
    await expect(app.executeAction(
      owner.id,
      'cli',
      'chart.create',
      {
        handleId: 'fake-handle',
        presentation: { series: ['count'], type: 'bar' },
        title: 'Selected pinned chart',
      },
      { typeId: 'chart', typeVersion: '1.0.0' },
    )).rejects.toBeDefined();
    const pinnedChart = await app.executeAction(
      owner.id,
      'cli',
      'chart.create',
      {
        handleId: chartHandle.id,
        presentation: { series: ['count'], type: 'bar' },
        title: 'Selected pinned chart',
      },
      { typeId: 'chart', typeVersion: '1.0.0' },
    );
    expect(await store.getChannel(pinnedChart.subject!.id)).toMatchObject({
      typeId: 'chart',
      typeVersion: '1.0.0',
    });
    const boundedSource = await app.executeQuery(owner.id, 'cli', 'chart.open', { channelId: pinnedChart.subject!.id });
    expect((boundedSource.data as Array<{ id: string }>).map((record) => record.id)).toContain(v1Record.subject!.id);
    expect((boundedSource.data as Array<{ id: string }>).map((record) => record.id)).not.toContain(v2Record.subject!.id);
    const v1Catalog = app.queries.catalog({ typeId: 'table', typeVersion: '1.0.0' });
    const v2Catalog = app.queries.catalog({ typeId: 'table', typeVersion: '2.0.0' });
    const defaultNames = app.queries.catalog().map((definition) => definition.name);
    expect(defaultNames).not.toContain('table.configuration');
    expect(defaultNames).not.toContain('table.custom.configuration');
    expect(defaultNames).not.toContain('chart.open');
    const configuration = (catalog: typeof v1Catalog) =>
      catalog.find((definition) => definition.name === 'table.configuration')!.inputSchema;
    const v1Names = v1Catalog.map((definition) => definition.name);
    expect(v1Names).toContain('channel.list');
    expect(v1Names).toContain('table.records.list');
    expect(v1Names).not.toContain('dictionary.entries.list');
    expect(v1Names).not.toContain('chart.open');
    expect(configuration(v1Catalog).required).toEqual(['channelId']);
    expect(configuration(v2Catalog).required).toEqual(['channelId', 'edition']);
    expect(v2Catalog.map((definition) => definition.name)).toContain('table.custom.configuration');
    expect(app.actions.catalog({ typeId: 'table', typeVersion: '2.0.0' }).map((definition) => definition.name))
      .toContain('table.custom.reset-display');
    await app.executeQuery(owner.id, 'cli', 'table.configuration', { channelId: 'table-v1' });
    await expect(
      app.executeQuery(owner.id, 'cli', 'table.configuration', { channelId: 'table-v2' }),
    ).rejects.toBeDefined();
    await expect(
      app.executeQuery(
        owner.id,
        'cli',
        'table.configuration',
        { channelId: 'table-v2', edition: 'v2' },
        { typeId: 'table', typeVersion: '1.0.0' },
      ),
    ).rejects.toMatchObject({ code: 'channel-type.version-mismatch' });
    const v2Result = await app.executeQuery(owner.id, 'cli', 'table.configuration', {
      channelId: 'table-v2',
      edition: 'v2',
    });
    expect(v2Result.view).toMatchObject({
      commands: [],
      kind: 'table-configuration-v2',
      title: 'Table Configuration v2',
    });
    expect(v2Result.data).toMatchObject({ edition: 'v2' });
    const customResult = await app.executeQuery(owner.id, 'cli', 'table.custom.configuration', {
      channelId: 'table-v2',
    });
    expect(customResult).toMatchObject({
      data: { mediated: true },
      view: { kind: 'table-custom-configuration', title: 'Custom configuration' },
    });
    await app.executeAction(owner.id, 'cli', 'table.custom.reset-display', {
      channelId: 'table-v2',
    });
    const viewer = await app.executeAction(owner.id, 'cli', 'service.person.create', {
      displayName: 'Pinned type viewer',
    });
    await app.executeAction(owner.id, 'cli', 'channel.member.grant', {
      channelId: 'table-v2',
      personId: viewer.subject!.id,
      role: 'viewer',
    });
    await expect(app.executeAction(viewer.subject!.id, 'cli', 'table.custom.reset-display', {
      channelId: 'table-v2',
    })).rejects.toMatchObject({ code: 'permission.denied' });
    await expect(app.executeQuery(
      viewer.subject!.id,
      'cli',
      'table.custom.operator-status',
      {},
      { typeId: 'table', typeVersion: '2.0.0' },
    )).rejects.toMatchObject({ code: 'permission.denied' });
    await expect(app.executeQuery(
      owner.id,
      'cli',
      'table.custom.operator-status',
      {},
      { typeId: 'table', typeVersion: '2.0.0' },
    )).resolves.toMatchObject({ data: { status: 'ready' } });
    const selectedOperatorHandle = await app.prepareQuery(
      owner.id,
      'agent',
      'table.custom.operator-status',
      {},
      'operator.status',
      { typeId: 'table', typeVersion: '2.0.0' },
    );
    await expect(app.consumeResultHandle(owner.id, selectedOperatorHandle.id, 'operator.status'))
      .resolves.toMatchObject({ data: { status: 'ready' } });
    const reopenedOperatorHandle = await app.reopenDataView(owner.id, 'agent', {
      input: {},
      purpose: 'operator.reopened',
      queryName: 'table.custom.operator-status',
      selectedType: { typeId: 'table', typeVersion: '2.0.0' },
    });
    await expect(app.consumeResultHandle(owner.id, reopenedOperatorHandle.id, 'operator.reopened'))
      .resolves.toMatchObject({ data: { status: 'ready' } });
    await app.executeAction(viewer.subject!.id, 'cli', 'table.view.create', {
      channelId: 'table-v2',
      filters: [],
      grouping: [],
      name: 'Scoped viewer view',
      sorting: [],
      visibility: 'personal',
      visibleFieldIds: [],
    });
    expect((await store.listOperations('table-v2')).at(-1)!.changes).toEqual([
      expect.objectContaining({ kind: 'table.view-saved' }),
      expect.objectContaining({ kind: 'activity.appended' }),
    ]);
    await app.executeAction(owner.id, 'cli', 'table.record.create', {
      channelId: 'table-v1',
      values: {},
    });
    await expect(
      app.executeAction(owner.id, 'cli', 'table.record.create', {
        channelId: 'table-v2',
        values: {},
      }),
    ).rejects.toThrow('Table v2 record mode is required');
    await app.executeAction(owner.id, 'cli', 'table.record.create', {
      channelId: 'table-v2',
      mode: 'v2',
      values: {},
    });
    await expect(
      app.executeAction(owner.id, 'cli', 'table.display-field.set', {
        channelId: 'table-v1',
        fieldId: 'v2-default',
      }),
    ).rejects.toThrow('Display Field does not exist');
    await app.executeAction(owner.id, 'cli', 'table.display-field.set', {
      channelId: 'table-v2',
      fieldId: 'v2-default',
    });
    expect(await store.getTableDisplayFieldId('table-v2')).toBeNull();
    expect((await store.listOperations('table-v2')).at(-1)?.changes).toContainEqual({
      channelId: 'table-v2',
      kind: 'table.display-field-set',
    });
  });

  test('rejects reads and actions for a Channel pinned to an unavailable version', async () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    await store.initialize();
    const owner = await store.ensureLocalOwner();
    const channel: Channel = {
      createdAt: new Date().toISOString(),
      id: 'future-table',
      ownerId: owner.id,
      title: 'Future table',
      typeId: 'table',
      typeVersion: '9.0.0',
      updatedAt: new Date().toISOString(),
    };
    const operation: Operation = {
      action: 'test.seed',
      actorId: owner.id,
      changes: [
        { channel, kind: 'channel.created' },
        {
          kind: 'membership.granted',
          membership: { channelId: channel.id, personId: owner.id, role: 'owner' },
        },
      ],
      channelId: channel.id,
      id: 'seed-future-table',
      intent: 'test.seed',
      occurredAt: new Date().toISOString(),
      origin: 'cli',
      result: { status: 'succeeded' },
      status: 'succeeded',
    };
    await store.commit(operation);
    const app = createDatagramApplication(store);

    for (const request of [
      () => app.executeQuery(owner.id, 'cli', 'table.describe', { channelId: channel.id }),
      () => app.executeAction(owner.id, 'cli', 'table.record.create', {
          channelId: channel.id,
          values: {},
        }),
    ]) {
      await expect(request()).rejects.toMatchObject({
        code: 'channel-type.version-unavailable',
      } satisfies Partial<DatagramError>);
    }
  });
});
