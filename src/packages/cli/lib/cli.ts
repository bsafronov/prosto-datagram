import { DatagramError, toPublicError } from '../../application/errors';
import type { ChannelTypeContractSelector } from '../../application/contracts';
import { createProcessCliHost, type CliHost } from './host';

export const cliUsage = `Usage:
  datagram init [--db PATH]
  datagram actions|queries [--type-id ID --type-version VERSION] [--db PATH]
  datagram action NAME [--type-id ID --type-version VERSION] [--input JSON] [--actor ID] [--db PATH]
  datagram query NAME [--type-id ID --type-version VERSION] [--input JSON] [--actor ID] [--db PATH]
  datagram agent-query NAME [--type-id ID --type-version VERSION] [--input JSON] [--actor ID] [--db PATH]
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

function channelType(args: readonly string[]): ChannelTypeContractSelector | undefined {
  const typeId = option(args, '--type-id');
  const typeVersion = option(args, '--type-version');
  if ((typeId === undefined) !== (typeVersion === undefined)) {
    throw new DatagramError(
      'input.invalid',
      '--type-id and --type-version must be provided together',
      400,
    );
  }
  return typeId === undefined || typeVersion === undefined ? undefined : { typeId, typeVersion };
}

function output(host: CliHost, value: unknown): void {
  host.terminal.writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeCliFailure(error: unknown, host: CliHost = createProcessCliHost()): void {
  const result = toPublicError(error);
  host.terminal.writeError(`${JSON.stringify(result.body)}\n`);
}

export async function runCli(
  args: readonly string[],
  host: CliHost = createProcessCliHost(),
): Promise<void> {
  const command = args[0];
  if (command === undefined || command === '--help' || command === '-h') {
    host.terminal.writeOutput(cliUsage);
    return;
  }

  if (command === 'serve') {
    const rawPort = option(args, '--port');
    const databasePath = option(args, '--db');
    const { identityMode, runtime, server } = await host.startHttpServer({
      ...(databasePath === undefined ? {} : { databasePath }),
      ...(rawPort === undefined ? {} : { port: Number(rawPort) }),
    });
    host.terminal.writeError(
      `Datagram HTTP listening on ${server.url.toString()} (${identityMode} identity mode)\n`,
    );
    const close = async () => {
      await server.stop();
      await runtime.close();
      host.exit(0);
    };
    host.onTermination(close);
    return;
  }

  const databasePath = option(args, '--db');
  const configuredDatabasePath = databasePath ?? host.environment.get('DATAGRAM_DB');
  const runtime = await host.createRuntime({
    ...(configuredDatabasePath === undefined ? {} : { databasePath: configuredDatabasePath }),
  });
  try {
    const actorId =
      option(args, '--actor') ?? host.environment.get('DATAGRAM_ACTOR_ID') ?? runtime.owner.id;
    const selector = channelType(args);
    switch (command) {
      case 'init':
        output(host, {
          databasePath: configuredDatabasePath ?? 'datagram.sqlite',
          owner: runtime.owner,
        });
        break;
      case 'actions':
        output(host, runtime.app.actions.catalog(selector));
        break;
      case 'queries':
        output(host, runtime.app.queries.catalog(selector));
        break;
      case 'action': {
        const name = required(args[1], 'Action name is required');
        if (selector && !runtime.app.actions.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('action.unknown', `Unknown definition: ${name}`, 404);
        }
        output(
          host,
          await runtime.app.executeAction(actorId, 'cli', name, input(args), selector),
        );
        break;
      }
      case 'query': {
        const name = required(args[1], 'Query name is required');
        if (selector && !runtime.app.queries.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('query.unknown', `Unknown definition: ${name}`, 404);
        }
        output(
          host,
          await runtime.app.executeQuery(actorId, 'cli', name, input(args), selector),
        );
        break;
      }
      case 'agent-query': {
        const name = required(args[1], 'Query name is required');
        if (selector && !runtime.app.queries.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('query.unknown', `Unknown definition: ${name}`, 404);
        }
        output(
          host,
          await runtime.app.prepareQuery(actorId, 'agent', name, input(args), undefined, selector),
        );
        break;
      }
      default:
        throw new DatagramError('cli.command-unknown', 'Unknown command', 400);
    }
  } finally {
    await runtime.close();
  }
}
