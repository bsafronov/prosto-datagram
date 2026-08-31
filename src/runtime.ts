import { DatagramApplication } from './application/datagram';
import { bundledChannelTypes, ChannelTypeRegistry } from './domain/channel-types';
import type { Person } from './domain/model';
import { SqliteStore } from './store/sqlite-store';

export interface DatagramRuntime {
  readonly app: DatagramApplication;
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
  const app = new DatagramApplication(
    store,
    new ChannelTypeRegistry(bundledChannelTypes),
  );
  return { app, close: () => store.close(), owner, store };
}
