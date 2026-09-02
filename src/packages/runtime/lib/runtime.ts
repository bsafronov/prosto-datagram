import { createDatagramApplication } from '../../application';
import type { DatagramApplicationPort } from '../../application/port';
import type { Person } from '../../application/store';
import { SqliteStore } from '../../sqlite-store';

export interface OpenDatagramRuntime {
  readonly app: DatagramApplicationPort;
  readonly store: SqliteStore;
  close(): Promise<void>;
}

export interface DatagramRuntime extends OpenDatagramRuntime {
  readonly owner: Person;
}

export interface RuntimeOptions {
  readonly databasePath?: string;
  readonly ownerDisplayName?: string;
}

export async function openRuntime(
  options: Pick<RuntimeOptions, 'databasePath'> = {},
): Promise<OpenDatagramRuntime> {
  const store = new SqliteStore(
    options.databasePath ?? process.env.DATAGRAM_DB ?? 'datagram.sqlite',
  );
  await store.initialize();
  const app = createDatagramApplication(store);
  return { app, close: () => store.close(), store };
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<DatagramRuntime> {
  const runtime = await openRuntime(options);
  const { app, store } = runtime;
  const owner = await store.ensureLocalOwner(options.ownerDisplayName);
  return { ...runtime, app, owner, store };
}
