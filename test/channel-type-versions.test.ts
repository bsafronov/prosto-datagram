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
import type { Channel, Operation, QueryResult } from '../src/packages/domain/model';
import { SqliteStore } from '../src/packages/sqlite-store';

const stores: SqliteStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe('Channel Type version pinning', () => {
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
          execute: (input, capabilities) => capabilities.execute(input),
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
            return capabilities.execute(input);
          }
          if (input.typeVersion !== '1.0.0') throw new Error('Pinned Chart version was not injected');
          return capabilities.changes.createChart!(input);
        },
      } : action),
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
                if (input.title !== 'Owned v1 creation' || !('changes' in capabilities)) return capabilities.execute(input);
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
                    return capabilities.execute(input);
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
                ) =>
                  input.fieldId === 'v2-default' && 'commit' in capabilities
                    ? (capabilities.changes.setTableDisplayField!(null), capabilities.commit())
                    : capabilities.execute(input),
              }
          : action,
      ), {
        allowedOperations: ['table.display-field.set' as const],
        authorization: { kind: 'channel-role' as const, minimumRole: 'admin' as const },
        execute: async (
          _input: { channelId: string },
          capabilities: Parameters<(typeof table.actions)[number]['execute']>[1],
        ) => {
          if (!('changes' in capabilities)) throw new Error('Action capabilities required');
          capabilities.changes.setTableDisplayField!(null);
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
                const result = await capabilities.read('table.configuration', {
                  channelId: input.channelId,
                });
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
          const result = await capabilities.read('table.configuration', { channelId: input.channelId });
          return { ...result, data: { mediated: true, source: result.data } };
        },
        inputSchema: z.object({ channelId: z.string().min(1) }),
        name: 'table.custom.configuration',
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
    const v1Catalog = app.queries.catalog({ typeId: 'table', typeVersion: '1.0.0' });
    const v2Catalog = app.queries.catalog({ typeId: 'table', typeVersion: '2.0.0' });
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
