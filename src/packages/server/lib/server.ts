import { createDatagramApplication } from '../../application';
import type { DatagramApplicationPort } from '../../application/port';
import type { Person } from '../../application/store';
import {
  createDevelopmentHttpHandler,
  createHttpHandler,
  type HttpIdentityVerifier,
} from '../../http';
import { PostgresStore } from '../../postgres-store';
import { createRuntime } from '../../runtime';

export type ServerIdentityMode =
  | { readonly kind: 'development' }
  | { readonly kind: 'production'; readonly verifyIdentity: HttpIdentityVerifier };

export interface ServerOptions {
  readonly databasePath?: string;
  readonly hostname?: string;
  readonly identity?: ServerIdentityMode;
  readonly port?: number;
}

export interface ServerServiceOptions {
  readonly authTokens?: Readonly<Record<string, string>>;
  readonly connectionString?: string;
  readonly deploymentOperatorDisplayName?: string;
  readonly deploymentOperatorId?: string;
  readonly deploymentOperatorToken?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly serviceKey?: string;
  readonly tls?: { readonly certificate: string; readonly key: string };
}

export interface ServerServiceRuntime {
  readonly app: DatagramApplicationPort;
  readonly deploymentOperator: Person;
  readonly store: PostgresStore;
  close(): Promise<void>;
}

function configuredTokens(): Readonly<Record<string, string>> {
  const raw = process.env.DATAGRAM_AUTH_TOKENS;
  if (raw === undefined || raw === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((personId) => typeof personId !== 'string')
  ) {
    throw new Error('DATAGRAM_AUTH_TOKENS must be a JSON object mapping tokens to person IDs');
  }
  return parsed as Readonly<Record<string, string>>;
}

export async function createServerServiceRuntime(
  options: ServerServiceOptions = {},
): Promise<ServerServiceRuntime> {
  const connectionString = options.connectionString ?? process.env.DATAGRAM_POSTGRES_URL;
  if (!connectionString) throw new Error('DATAGRAM_POSTGRES_URL is required for Server Service');
  const store = new PostgresStore({
    connectionString,
    ...(options.serviceKey === undefined ? {} : { serviceKey: options.serviceKey }),
  });
  await store.initialize();
  const deploymentOperator = await store.ensureDeploymentOperator({
    ...(options.deploymentOperatorDisplayName === undefined
      ? {}
      : { displayName: options.deploymentOperatorDisplayName }),
    ...(options.deploymentOperatorId === undefined ? {} : { id: options.deploymentOperatorId }),
  });
  return {
    app: createDatagramApplication(store),
    close: () => store.close(),
    deploymentOperator,
    store,
  };
}

export async function startServerService(options: ServerServiceOptions = {}) {
  const runtime = await createServerServiceRuntime(options);
  const tokens = new Map(Object.entries(options.authTokens ?? configuredTokens()));
  const operatorToken = options.deploymentOperatorToken ?? process.env.DATAGRAM_OPERATOR_TOKEN;
  if (operatorToken) tokens.set(operatorToken, runtime.deploymentOperator.id);
  const verifyIdentity: HttpIdentityVerifier = async (request) => {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const personId = tokens.get(authorization.slice('Bearer '.length));
    if (!personId) return undefined;
    const person = await runtime.store.getPerson(personId);
    return person && person.deactivatedAt === undefined ? { actorId: person.id } : undefined;
  };
  const server = Bun.serve({
    fetch: createHttpHandler({ app: runtime.app, verifyIdentity }),
    hostname: options.hostname ?? process.env.HOST ?? '127.0.0.1',
    port: options.port ?? Number(process.env.PORT ?? 3100),
    ...(options.tls === undefined
      ? {}
      : { tls: { cert: options.tls.certificate, key: options.tls.key } }),
  });
  return { runtime, server };
}

export async function startHttpServer(options: ServerOptions = {}) {
  const runtime = await createRuntime({
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
  });
  const identity = options.identity ?? { kind: 'development' };
  const fetch =
    identity.kind === 'production'
      ? createHttpHandler({ app: runtime.app, verifyIdentity: identity.verifyIdentity })
      : createDevelopmentHttpHandler({ app: runtime.app, defaultActorId: runtime.owner.id });
  const server = Bun.serve({
    fetch,
    hostname: options.hostname ?? process.env.HOST ?? '127.0.0.1',
    port: options.port ?? Number(process.env.PORT ?? 3100),
  });
  return { identityMode: identity.kind, runtime, server };
}
