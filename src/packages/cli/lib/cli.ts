import { DatagramError, toPublicError } from '../../application/errors';
import type { ChannelTypeContractSelector } from '../../application/contracts';
import { createRemoteServiceApplication } from '../../remote-service-client';
import { createProcessCliHost, type CliHost } from './host';
import { runDoctor } from './doctor';
import { runGuidedInit } from './init';
import {
  isServerProfile,
  readServiceProfile,
  resolveCredential,
  resolveSelectedServiceProfile,
  resolveServiceTarget,
} from './profiles';

export const cliUsage = `Usage:
  datagram init [--profile NAME]
  datagram doctor --profile NAME [--verbose]
  datagram postgres start|stop|status --profile NAME
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

  if (command === 'postgres') {
    const operation = args[1];
    if (!['start', 'stop', 'status'].includes(operation ?? '')) {
      throw new DatagramError('input.invalid', 'Choose PostgreSQL lifecycle operation: start, stop, or status.', 400);
    }
    const profileName = required(option(args, '--profile'), '`postgres` requires --profile NAME');
    const profile = await readServiceProfile(host, profileName);
    if (!isServerProfile(profile) || profile.service.infrastructure.kind !== 'docker-postgres') {
      throw new DatagramError(
        'postgres.not-managed',
        `Service profile ${JSON.stringify(profileName)} does not own PostgreSQL infrastructure. External PostgreSQL lifecycle is unchanged.`,
        400,
      );
    }
    if (host.dockerPostgres === undefined || !(await host.dockerPostgres.available())) {
      throw new DatagramError(
        'docker.unavailable',
        'Docker is unavailable. Install or start Docker yourself, then retry. Docker was not installed.',
        400,
      );
    }
    const definition = { profileName, ...profile.service.infrastructure };
    if (operation === 'start') await host.dockerPostgres.start(definition);
    if (operation === 'stop') await host.dockerPostgres.stop(definition);
    const status = await host.dockerPostgres.status(definition);
    host.terminal.writeOutput(
      `Managed PostgreSQL: ${status}; profile=${JSON.stringify(profileName)}; data=${profile.service.infrastructure.volumeName}\n`,
    );
    return;
  }

  if (command === 'serve') {
    const rawPort = option(args, '--port');
    const profileName = option(args, '--profile');
    if (profileName !== undefined) {
      const profile = await readServiceProfile(host, profileName);
      if (isServerProfile(profile)) {
        if (profile.service.infrastructure.kind === 'docker-postgres') {
          if (host.dockerPostgres === undefined || !(await host.dockerPostgres.available())) {
            throw new DatagramError(
              'docker.unavailable',
              'Docker is unavailable. Install or start Docker yourself, then retry. Docker was not installed.',
              400,
            );
          }
          await host.dockerPostgres.start({ profileName, ...profile.service.infrastructure });
        }
        if (host.startServerService === undefined) {
          throw new DatagramError('server.unavailable', 'Server Service startup is unavailable.', 500);
        }
        const connectionString = await resolveCredential(host, profile.service.postgres.credential);
        const deploymentOperatorToken = await resolveCredential(
          host,
          profile.identity.bearerCredential,
        );
        const { runtime, server } = await host.startServerService({
          connectionString,
          deploymentOperatorDisplayName: profile.identity.displayName,
          deploymentOperatorId: profile.identity.personId,
          deploymentOperatorToken,
          hostname: profile.service.bind.hostname,
          port: rawPort === undefined ? profile.service.bind.port : Number(rawPort),
          serviceKey: profile.service.serviceKey,
          ...(profile.service.publicAccess?.kind === 'direct-tls'
            ? {
                tls: {
                  certificate: await host.filesystem.readTextFile(
                    profile.service.publicAccess.certificatePath,
                  ),
                  key: await host.filesystem.readTextFile(profile.service.publicAccess.keyPath),
                },
              }
            : {}),
        });
        host.terminal.writeError(
          `Datagram HTTP listening on ${server.url.toString()} (production identity mode)\n`,
        );
        const close = async () => {
          await server.stop();
          await runtime.close();
          host.exit(0);
        };
        host.onTermination(close);
        return;
      }
    }
    const target = await resolveServiceTarget(host, {
      actorId: option(args, '--actor'),
      databasePath: option(args, '--db'),
      profileName,
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
    await runGuidedInit(host, option(args, '--profile'));
    return;
  }

  if (command === 'doctor') {
    await runDoctor(host, option(args, '--profile'), args.includes('--verbose'));
    return;
  }

  if (!['actions', 'queries', 'action', 'query', 'agent-query'].includes(command)) {
    throw new DatagramError('cli.command-unknown', 'Unknown command', 400);
  }

  const targetOptions = {
    actorId: option(args, '--actor'),
    databasePath: option(args, '--db'),
    profileName: option(args, '--profile'),
  };
  const selectedProfile = await resolveSelectedServiceProfile(host, targetOptions);
  const target =
    selectedProfile !== undefined && isServerProfile(selectedProfile)
      ? undefined
      : await resolveServiceTarget(host, targetOptions);
  const remote = selectedProfile !== undefined && isServerProfile(selectedProfile);
  const selector = channelType(args);
  const remoteApp = remote
    ? await createRemoteServiceApplication({
        baseUrl:
          selectedProfile.service.publicAccess?.kind === 'reverse-proxy'
            ? new URL(selectedProfile.service.publicAccess.endpoint)
            : new URL(
                `${selectedProfile.service.publicAccess?.kind === 'direct-tls' ? 'https' : 'http'}://${selectedProfile.service.bind.hostname}:${selectedProfile.service.bind.port}/`,
              ),
        bearerToken: await resolveCredential(host, selectedProfile.identity.bearerCredential),
        ...(selector === undefined ? {} : { channelType: selector }),
        request: host.request ?? ((request) => fetch(request)),
      })
    : undefined;
  const localRuntime = remote
    ? undefined
    : await host.createRuntime({ databasePath: target!.databasePath });
  try {
    const activeApp = localRuntime?.app ?? remoteApp!;
    const actorId = remote
      ? selectedProfile.identity.personId
      : target!.actorId ?? localRuntime!.owner.id;
    switch (command) {
      case 'actions':
        output(host, activeApp.actions.catalog(selector));
        break;
      case 'queries':
        output(host, activeApp.queries.catalog(selector));
        break;
      case 'action': {
        const name = required(args[1], 'Action name is required');
        if (selector && !activeApp.actions.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('action.unknown', `Unknown definition: ${name}`, 404);
        }
        output(
          host,
          await activeApp.executeAction(actorId, 'cli', name, input(args), selector),
        );
        break;
      }
      case 'query': {
        const name = required(args[1], 'Query name is required');
        if (selector && !activeApp.queries.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('query.unknown', `Unknown definition: ${name}`, 404);
        }
        output(
          host,
          await activeApp.executeQuery(actorId, 'cli', name, input(args), selector),
        );
        break;
      }
      case 'agent-query': {
        const name = required(args[1], 'Query name is required');
        if (selector && !activeApp.queries.list(selector).some((value) => value.name === name)) {
          throw new DatagramError('query.unknown', `Unknown definition: ${name}`, 404);
        }
        output(
          host,
          await activeApp.prepareQuery(actorId, 'agent', name, input(args), undefined, selector),
        );
        break;
      }
      default:
        throw new DatagramError('cli.command-unknown', 'Unknown command', 400);
    }
  } finally {
    await localRuntime?.close();
  }
}
