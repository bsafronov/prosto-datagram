import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatagramStore } from '../src/packages/application/store';
import { SqliteStore } from '../src/packages/sqlite-store';
import { storeConformance } from './store-conformance';

storeConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-store-conformance-'));
  const databasePath = join(directory, 'datagram.sqlite');
  const stores = new Set<DatagramStore>();

  const open = async (): Promise<DatagramStore> => {
    const store = new SqliteStore(databasePath);
    await store.initialize();
    stores.add(store);
    return store;
  };

  return {
    dispose: async () => {
      await Promise.all(
        [...stores].map(async (store) => {
          try {
            await store.close();
          } catch {
            // Tests may close a Store before reopening the same persistent database.
          }
        }),
      );
      await rm(directory, { force: true, recursive: true });
    },
    reopen: open,
    store: await open(),
  };
});

test('SQLite Store migrates legacy Operation intent and result independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-store-migration-'));
  const databasePath = join(directory, 'datagram.sqlite');
  const legacy = new Database(databasePath, { create: true, strict: true });
  legacy.exec(`
    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      action TEXT NOT NULL,
      channel_id TEXT,
      status TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO operations VALUES (
      'legacy-operation',
      'legacy-actor',
      'system',
      'legacy.action',
      'legacy-channel',
      'succeeded',
      '[]',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  legacy.close(false);

  const store = new SqliteStore(databasePath);
  try {
    await store.initialize();
    expect(await store.listOperations('legacy-channel')).toEqual([
      expect.objectContaining({
        action: 'legacy.action',
        intent: 'legacy.action',
        result: 'succeeded',
        status: 'succeeded',
      }),
    ]);
  } finally {
    await store.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('SQLite Store backfills legacy Table Field and per-Field Record versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-table-migration-'));
  const databasePath = join(directory, 'datagram.sqlite');
  const legacy = new Database(databasePath, { create: true, strict: true });
  legacy.exec(`
    CREATE TABLE table_fields (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      unique_value INTEGER NOT NULL DEFAULT 0,
      default_json TEXT,
      target_channel_id TEXT,
      cardinality TEXT
    );
    INSERT INTO table_fields VALUES (
      'legacy-field', 'legacy-channel', 'name', 'Name', 'text', 0, 0, NULL, NULL, NULL
    );
    CREATE TABLE table_records (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      values_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO table_records VALUES (
      'legacy-record',
      'legacy-channel',
      '{"name":"Preserved","count":3}',
      'legacy-actor',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  legacy.close(false);

  const store = new SqliteStore(databasePath);
  try {
    await store.initialize();
    expect(await store.listTableFields('legacy-channel')).toEqual([
      expect.objectContaining({ id: 'legacy-field', version: 1 }),
    ]);
    expect(await store.getTableRecord('legacy-record')).toMatchObject({
      fieldVersions: { count: 1, name: 1 },
      values: { count: 3, name: 'Preserved' },
    });
  } finally {
    await store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
