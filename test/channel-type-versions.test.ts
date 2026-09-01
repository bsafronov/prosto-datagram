import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createDatagramApplication } from '../src/packages/application';
import {
  bundledChannelTypes,
  ChannelTypeRegistry,
} from '../src/packages/domain/channel-types';
import type { Channel, Operation } from '../src/packages/domain/model';
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
    }
  });

  test('deep-freezes installed definitions, contracts, schemas, and views', () => {
    const registry = new ChannelTypeRegistry(bundledChannelTypes);
    const definition = registry.require('table', '1.0.0');
    expect(Object.isFrozen(definition)).toBeTrue();
    expect(Object.isFrozen(definition.actions)).toBeTrue();
    expect(Object.isFrozen(definition.actions[0])).toBeTrue();
    expect(Object.isFrozen(definition.actions[0]!.inputSchema)).toBeTrue();
    expect(Object.isFrozen(definition.views)).toBeTrue();
    expect(Object.isFrozen(definition.views[0])).toBeTrue();
    expect(Object.isFrozen(definition.views[0]!.commands)).toBeTrue();
    expect(() => definition.views[0]!.commands.push('mutated')).toThrow();
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
