import {
  createDevelopmentHttpHandler,
  createHttpHandler,
  type HttpIdentityVerifier,
} from '../../http';
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
