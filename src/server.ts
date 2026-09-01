import { startHttpServer } from './packages/server';

export { startHttpServer, type ServerOptions } from './packages/server';

if (import.meta.main) {
  const { identityMode, runtime, server } = await startHttpServer();
  process.stderr.write(
    `Datagram HTTP listening on ${server.url.toString()} (${identityMode} identity mode)\n`,
  );
  const close = async () => {
    await server.stop();
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
