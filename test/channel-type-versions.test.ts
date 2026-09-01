import { afterEach, describe, expect, test } from 'bun:test';
import * as z from 'zod/v4';

import { DatagramError } from '../src/packages/application/errors';
import { createDatagramApplication, DatagramApplication } from '../src/packages/application';
import {
  bundledChannelTypes,
  ChannelTypeRegistry,
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
          execute: (input, next) => next(input),
          inputSchema: source,
          name: 'custom.write',
        }],
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
    const v2 = {
      ...table,
      actions: table.actions.map((action) =>
        action.name === 'table.record.create'
          ? {
              ...action,
              inputSchema: z.object({
                channelId: z.string().min(1),
                mode: z.literal('v2').optional(),
                values: z.record(z.string(), z.unknown()),
              }),
            }
          : action.name === 'table.display-field.set'
            ? {
                ...action,
                execute: async (
                  input: { channelId: string; fieldId: string | null },
                  next: (input: { channelId: string; fieldId: string | null }) => Promise<unknown>,
                  capabilities: Parameters<typeof action.execute>[2],
                ) =>
                  input.fieldId === 'v2-default' && 'commit' in capabilities
                    ? capabilities.commit({
                        changes: [{
                          channelId: input.channelId,
                          kind: 'table.display-field-set',
                        }],
                        channelId: input.channelId,
                        requiredRole: 'admin',
                      })
                    : next(input),
              }
          : action,
      ),
      queries: table.queries.map((query) =>
        query.name === 'table.configuration'
          ? {
              ...query,
              execute: async (
                input: { channelId: string; edition: 'v2' },
                next: (input: { channelId: string; edition: 'v2' }) => Promise<unknown>,
              ) => {
                const result = (await next(input)) as QueryResult;
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
      ),
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
      views: table.views.map((view) =>
        view.query === 'table.configuration'
          ? {
              ...view,
              commands: [],
              kind: 'table-configuration-v2',
              produce: (candidate: Parameters<ChannelTypeRegistry['produceView']>[3]) => ({
                ...candidate,
                commands: [],
                kind: 'table-configuration-v2',
                title: 'Table Configuration v2',
              }),
            }
          : view,
      ),
    };
    const registry = new ChannelTypeRegistry([
      ...bundledChannelTypes.filter((definition) => definition.id !== 'table'),
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
