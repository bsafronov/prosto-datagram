import { DatagramError, toPublicError } from '../../application/errors';
import type { ChannelTypeContractSelector } from '../../application/contracts';
import { createProcessCliHost, type CliHost } from './host';
import { runDoctor } from './doctor';
import { runGuidedInit } from './init';
import { resolveServiceTarget } from './profiles';

export const cliUsage = `Usage:
  datagram init
  datagram doctor --profile NAME [--verbose]
  datagram actions|queries [--type-id ID --type-version VERSION] [--profile NAME | --db PATH]
  datagram action NAME [--type-id ID --type-version VERSION] [--input JSON] [--profile NAME | --actor ID --db PATH]
  datagram query NAME [--type-id ID --type-version VERSION] [--input JSON] [--profile NAME | --actor ID --db PATH]
  datagram agent-query NAME [--type-id ID --type-version VERSION] [--input JSON] [--profile NAME | --actor ID --db PATH]
  datagram serve [--port NUMBER] [--profile NAME | --db PATH]
`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new DatagramError('input.invalid', `${name} requires a value`, 400);
  }
  return value;
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
    const target = await resolveServiceTarget(host, {
      actorId: option(args, '--actor'),
      databasePath: option(args, '--db'),
      profileName: option(args, '--profile'),
    });
    const { identityMode, runtime, server } = await host.startHttpServer({
      databasePath: target.databasePath,
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

  if (command === 'init') {
    await runGuidedInit(host);
    return;
  }

  if (command === 'doctor') {
    await runDoctor(host, option(args, '--profile'), args.includes('--verbose'));
    return;
  }

  if (!['actions', 'queries', 'action', 'query', 'agent-query'].includes(command)) {
    throw new DatagramError('cli.command-unknown', 'Unknown command', 400);
  }

  const target = await resolveServiceTarget(host, {
    actorId: option(args, '--actor'),
    databasePath: option(args, '--db'),
    profileName: option(args, '--profile'),
  });
  const runtime = await host.createRuntime({ databasePath: target.databasePath });
  try {
    const actorId = target.actorId ?? runtime.owner.id;
    const selector = channelType(args);
    switch (command) {
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
