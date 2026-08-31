import { createHttpHandler } from '../../http';
import { createRuntime } from '../../runtime';

export interface ServerOptions {
  readonly databasePath?: string;
  readonly hostname?: string;
  readonly port?: number;
}

export async function startHttpServer(options: ServerOptions = {}) {
  const runtime = await createRuntime({
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
  });
  const server = Bun.serve({
    fetch: createHttpHandler({ app: runtime.app, defaultActorId: runtime.owner.id }),
    hostname: options.hostname ?? process.env.HOST ?? '127.0.0.1',
    port: options.port ?? Number(process.env.PORT ?? 3100),
  });
  return { runtime, server };
}
