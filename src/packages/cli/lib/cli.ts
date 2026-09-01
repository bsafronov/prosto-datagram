import { DatagramError, toPublicError } from '../../application/errors';
import { createRuntime } from '../../runtime';
import { startHttpServer } from '../../server';

export const cliUsage = `Usage:
  datagram init [--db PATH]
  datagram actions|queries [--db PATH]
  datagram action NAME [--input JSON] [--actor ID] [--db PATH]
  datagram query NAME [--input JSON] [--actor ID] [--db PATH]
  datagram agent-query NAME [--input JSON] [--actor ID] [--db PATH]
  datagram serve [--port NUMBER] [--db PATH]
`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, message: string): string {
  if (value === undefined) throw new DatagramError('input.invalid', message, 400);
  return value;
}

function input(args: readonly string[]): unknown {
  const raw = option(args, '--input');
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DatagramError('json.invalid', 'Invalid JSON input', 400);
  }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeCliFailure(error: unknown): void {
  const result = toPublicError(error);
  process.stderr.write(`${JSON.stringify(result.body)}\n`);
}

export async function runCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(cliUsage);
    return;
  }

  if (command === 'serve') {
    const rawPort = option(args, '--port');
    const databasePath = option(args, '--db');
    const { identityMode, runtime, server } = await startHttpServer({
      ...(databasePath === undefined ? {} : { databasePath }),
      ...(rawPort === undefined ? {} : { port: Number(rawPort) }),
    });
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
    return;
  }

  const databasePath = option(args, '--db');
  const runtime = await createRuntime({
    ...(databasePath === undefined ? {} : { databasePath }),
  });
  try {
    const actorId = option(args, '--actor') ?? process.env.DATAGRAM_ACTOR_ID ?? runtime.owner.id;
    switch (command) {
      case 'init':
        output({
          databasePath: databasePath ?? process.env.DATAGRAM_DB ?? 'datagram.sqlite',
          owner: runtime.owner,
        });
        break;
      case 'actions':
        output(runtime.app.actions.catalog());
        break;
      case 'queries':
        output(runtime.app.queries.catalog());
        break;
      case 'action':
        output(
          await runtime.app.executeAction(
            actorId,
            'cli',
            required(args[1], 'Action name is required'),
            input(args),
          ),
        );
        break;
      case 'query':
        output(
          await runtime.app.executeQuery(
            actorId,
            'cli',
            required(args[1], 'Query name is required'),
            input(args),
          ),
        );
        break;
      case 'agent-query':
        output(
          await runtime.app.prepareQuery(
            actorId,
            'agent',
            required(args[1], 'Query name is required'),
            input(args),
          ),
        );
        break;
      default:
        throw new DatagramError('cli.command-unknown', 'Unknown command', 400);
    }
  } finally {
    await runtime.close();
  }
}
