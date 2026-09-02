import { DatagramError } from '../../application/errors';
import type { ExternalCommandRequest, ExternalCommandResult } from './host';

export const managedPostgresImage =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';

const managedLabel = 'io.prosto-datagram.managed';
const profileLabel = 'io.prosto-datagram.profile';

export interface ManagedPostgresDefinition {
  readonly profileName: string;
  readonly image: string;
  readonly containerName: string;
  readonly volumeName: string;
  readonly port: number;
}

export interface ManagedPostgresCreate extends ManagedPostgresDefinition {
  readonly password: string;
}

export type ManagedPostgresState = 'missing' | 'stopped' | 'running';

export interface DockerPostgresPort {
  available(): Promise<boolean>;
  ensure(definition: ManagedPostgresCreate): Promise<void>;
  start(definition: ManagedPostgresDefinition): Promise<void>;
  stop(definition: ManagedPostgresDefinition): Promise<void>;
  status(definition: ManagedPostgresDefinition): Promise<ManagedPostgresState>;
}

interface DockerInspect {
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>>;
  };
  readonly HostConfig?: {
    readonly PortBindings?: Readonly<Record<string, readonly { readonly HostIp?: string; readonly HostPort?: string }[]>>;
  };
  readonly Mounts?: readonly { readonly Destination?: string; readonly Name?: string; readonly Type?: string }[];
  readonly State?: { readonly Running?: boolean };
}

function owned(definition: ManagedPostgresDefinition, labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.[managedLabel] === 'true' && labels[profileLabel] === definition.profileName;
}

function failure(message: string): DatagramError {
  return new DatagramError('docker.postgres-invalid', message, 400);
}

export function managedPostgresDefinition(profileName: string, port: number): ManagedPostgresDefinition {
  const slug = profileName.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, '-');
  return {
    profileName,
    image: managedPostgresImage,
    containerName: `prosto-datagram-postgres-${slug}`,
    volumeName: `prosto-datagram-postgres-${slug}-data`,
    port,
  };
}

export function createDockerPostgresPort(
  run: (request: ExternalCommandRequest) => Promise<ExternalCommandResult>,
): DockerPostgresPort {
  const docker = (
    args: readonly string[],
    environment?: Readonly<Record<string, string | undefined>>,
  ) => run({ command: 'docker', args, ...(environment ? { environment } : {}) });
  const inspect = async (definition: ManagedPostgresDefinition): Promise<DockerInspect | undefined> => {
    const result = await docker(['container', 'inspect', definition.containerName]);
    if (result.exitCode !== 0) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'object' || parsed[0] === null) throw new Error();
      return parsed[0] as DockerInspect;
    } catch {
      throw failure('Managed PostgreSQL container state is unreadable. Check Docker, then retry.');
    }
  };
  const validated = async (definition: ManagedPostgresDefinition): Promise<DockerInspect | undefined> => {
    const value = await inspect(definition);
    if (!value) return undefined;
    const binding = value.HostConfig?.PortBindings?.['5432/tcp']?.[0];
    const volume = value.Mounts?.find((mount) => mount.Destination === '/var/lib/postgresql/data');
    if (
      !owned(definition, value.Config?.Labels) ||
      value.Config?.Image !== definition.image ||
      binding?.HostIp !== '127.0.0.1' ||
      binding.HostPort !== String(definition.port) ||
      volume?.Type !== 'volume' ||
      volume.Name !== definition.volumeName
    ) {
      throw failure(
        'Managed PostgreSQL infrastructure differs from its profile. Repair it explicitly; no container or data was removed.',
      );
    }
    return value;
  };
  const requireSuccess = (result: ExternalCommandResult, message: string): void => {
    if (result.exitCode !== 0) throw new DatagramError('docker.command-failed', message, 500);
  };
  return {
    available: async () => {
      try {
        return (await docker(['version', '--format', '{{.Server.Version}}'])).exitCode === 0;
      } catch {
        return false;
      }
    },
    status: async (definition) => {
      const value = await validated(definition);
      return value === undefined ? 'missing' : value.State?.Running ? 'running' : 'stopped';
    },
    ensure: async (definition) => {
      const current = await validated(definition);
      if (current) {
        if (!current.State?.Running) {
          requireSuccess(
            await docker(['start', definition.containerName]),
            'Managed PostgreSQL could not be started. Check Docker, then retry.',
          );
        }
        return;
      }
      const volume = await docker(['volume', 'inspect', definition.volumeName]);
      if (volume.exitCode === 0) {
        let labels: Readonly<Record<string, string>> | undefined;
        try {
          const parsed = JSON.parse(volume.stdout) as readonly { readonly Labels?: Readonly<Record<string, string>> }[];
          labels = parsed[0]?.Labels;
        } catch {
          throw failure('Managed PostgreSQL volume state is unreadable. Check Docker, then retry.');
        }
        if (!owned(definition, labels)) {
          throw failure('Docker volume name is already used by infrastructure not owned by this profile.');
        }
      } else {
        requireSuccess(
          await docker([
            'volume', 'create',
            '--label', `${managedLabel}=true`,
            '--label', `${profileLabel}=${definition.profileName}`,
            definition.volumeName,
          ]),
          'Persistent PostgreSQL volume could not be created. Check Docker, then retry.',
        );
      }
      requireSuccess(
        await docker([
          'run', '--detach',
          '--name', definition.containerName,
          '--label', `${managedLabel}=true`,
          '--label', `${profileLabel}=${definition.profileName}`,
          '--env', 'POSTGRES_DB=datagram',
          '--env', 'POSTGRES_PASSWORD',
          '--env', 'POSTGRES_USER=datagram',
          '--publish', `127.0.0.1:${definition.port}:5432`,
          '--volume', `${definition.volumeName}:/var/lib/postgresql/data`,
          definition.image,
        ], { POSTGRES_PASSWORD: definition.password }),
        'Managed PostgreSQL could not be created. Persistent volume was retained.',
      );
    },
    start: async (definition) => {
      const state = await validated(definition);
      if (!state) throw failure('Managed PostgreSQL container is missing. Run `datagram init` to repair it.');
      if (!state.State?.Running) requireSuccess(await docker(['start', definition.containerName]), 'Managed PostgreSQL could not be started.');
    },
    stop: async (definition) => {
      const state = await validated(definition);
      if (!state) throw failure('Managed PostgreSQL container is missing. Run `datagram init` to repair it.');
      if (state.State?.Running) requireSuccess(await docker(['stop', definition.containerName]), 'Managed PostgreSQL could not be stopped.');
    },
  };
}
