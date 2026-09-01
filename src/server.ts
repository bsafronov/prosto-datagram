import { startServerService } from './packages/server';

export {
  createServerServiceRuntime,
  startServerService,
  type ServerServiceOptions,
  type ServerServiceRuntime,
} from './packages/server';

if (import.meta.main) {
  const { runtime, server } = await startServerService();
  process.stderr.write(`Datagram HTTP listening on ${server.url.toString()}\n`);
  const close = async () => {
    await server.stop();
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
