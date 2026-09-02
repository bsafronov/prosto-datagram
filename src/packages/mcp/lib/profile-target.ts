import { DatagramError } from '../../application/errors';
import {
  isServerProfile,
  readServiceProfile,
  resolveCredential,
  resolveServiceTarget,
  type CliHost,
  type ServerServiceProfile,
} from '../../cli';
import { createRuntime } from '../../runtime';
import type { McpApplicationPort } from './gateway';
import { createRemoteMcpApplication } from './remote-application';

export interface McpRuntimeTarget {
  readonly runtime: {
    readonly app: McpApplicationPort;
    close(): void | Promise<void>;
  };
  readonly actorId?: string;
}

function serverUrl(profile: ServerServiceProfile): URL {
  if (profile.service.publicAccess?.kind === 'reverse-proxy') {
    return new URL(profile.service.publicAccess.endpoint);
  }
  const protocol = profile.service.publicAccess?.kind === 'direct-tls' ? 'https' : 'http';
  return new URL(`${protocol}://${profile.service.bind.hostname}:${profile.service.bind.port}/`);
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new DatagramError('input.invalid', `${name} requires a value`, 400);
  }
  return value;
}

export async function openMcpRuntimeTarget(
  args: readonly string[],
  host: CliHost,
): Promise<McpRuntimeTarget> {
  const profileName = option(args, '--profile');
  if (profileName === undefined) {
    const actorId = host.environment.get('DATAGRAM_ACTOR_ID');
    return {
      runtime: await createRuntime(),
      ...(actorId === undefined ? {} : { actorId }),
    };
  }
  const profile = await readServiceProfile(host, profileName);
  if (isServerProfile(profile)) {
    const bearerToken = await resolveCredential(host, profile.identity.bearerCredential);
    const app = await createRemoteMcpApplication({
      baseUrl: serverUrl(profile),
      bearerToken,
      request: host.request ?? ((request) => fetch(request)),
    });
    return {
      runtime: { app, close: () => undefined },
      actorId: profile.identity.personId,
    };
  }
  const target = await resolveServiceTarget(host, { profileName });
  return {
    runtime: await host.openRuntime({ databasePath: target.databasePath }),
    ...(target.actorId === undefined ? {} : { actorId: target.actorId }),
  };
}
