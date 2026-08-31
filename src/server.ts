import { createHttpHandler } from './http';
import { createRuntime } from './runtime';

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

if (import.meta.main) {
  const { runtime, server } = await startHttpServer();
  process.stderr.write(`Datagram HTTP listening on ${server.url.toString()}\n`);
  const close = async () => {
    await server.stop();
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
