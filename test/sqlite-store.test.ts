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
