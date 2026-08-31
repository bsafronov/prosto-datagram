import { createDatagramApplication } from '../../application';
import type { DatagramApplicationPort } from '../../application/port';
import type { Person } from '../../application/store';
import { SqliteStore } from '../../sqlite-store';

export interface DatagramRuntime {
  readonly app: DatagramApplicationPort;
  readonly owner: Person;
  readonly store: SqliteStore;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  readonly databasePath?: string;
  readonly ownerDisplayName?: string;
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<DatagramRuntime> {
  const store = new SqliteStore(
    options.databasePath ?? process.env.DATAGRAM_DB ?? 'datagram.sqlite',
  );
  await store.initialize();
  const owner = await store.ensureLocalOwner(options.ownerDisplayName);
  const app = createDatagramApplication(store);
  return { app, close: () => store.close(), owner, store };
}
