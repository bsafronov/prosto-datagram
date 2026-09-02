import { isAbsolute, join, resolve } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { CredentialReference } from './credentials';
import type { CliHost } from './host';

export const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LocalServiceProfile {
  readonly version: 1;
  readonly name: string;
  readonly service: {
    readonly kind: 'local';
    readonly databasePath: string;
  };
  readonly identity: {
    readonly personId: string;
    readonly displayName: string;
  };
  readonly setup?: {
    readonly core: 'verified';
    readonly starter: StarterProgress;
  };
}

export type ServerExposure = 'host' | 'private' | 'public';

export interface ServerServiceProfile {
  readonly version: 1;
  readonly name: string;
  readonly service: {
    readonly kind: 'server';
    readonly infrastructure:
      | { readonly kind: 'external-postgres' }
      | {
          readonly kind: 'docker-postgres';
          readonly image: string;
          readonly containerName: string;
          readonly volumeName: string;
          readonly port: number;
        };
    readonly serviceKey: string;
    readonly postgres: { readonly credential: CredentialReference };
    readonly bind: {
      readonly exposure: ServerExposure;
      readonly hostname: string;
      readonly port: number;
    };
    readonly publicAccess?:
      | {
          readonly kind: 'reverse-proxy';
          readonly endpoint: string;
        }
      | {
          readonly kind: 'direct-tls';
          readonly certificatePath: string;
          readonly keyPath: string;
        };
  };
  readonly identity: {
    readonly personId: string;
    readonly displayName: string;
    readonly bearerCredential: CredentialReference;
  };
  readonly setup?: { readonly core: 'verified' };
}

export type ServiceProfile = LocalServiceProfile | ServerServiceProfile;

export function isServerProfile(profile: ServiceProfile): profile is ServerServiceProfile {
  return profile.service.kind === 'server';
}

export type StarterProgress =
  | { readonly status: 'pending' }
  | {
      readonly status: 'channel-created';
      readonly channelId: string;
      readonly channelOperationId: string;
    }
  | {
      readonly status: 'field-created';
      readonly channelId: string;
      readonly channelOperationId: string;
      readonly fieldOperationId: string;
    }
  | {
      readonly status: 'complete';
      readonly channelId: string;
      readonly channelOperationId: string;
      readonly fieldOperationId: string;
      readonly recordOperationId: string;
    };

export interface TargetOptions {
  readonly profileName?: string | undefined;
  readonly databasePath?: string | undefined;
  readonly actorId?: string | undefined;
}

export interface ResolvedServiceTarget {
  readonly kind: 'local';
  readonly databasePath: string;
  readonly actorId?: string;
  readonly profileName?: string;
}

function invalidProfile(message: string): DatagramError {
  return new DatagramError('profile.invalid', message, 400);
}

export async function resolveCredential(
  host: CliHost,
  reference: CredentialReference,
): Promise<string> {
  if (reference.kind === 'native') {
    if (
      host.credentialProvider === undefined ||
      host.credentialProvider.kind !== reference.provider
    ) {
      throw new DatagramError(
        'credential.native-unavailable',
        'The native credential provider is unavailable on this host.',
        400,
      );
    }
    return host.credentialProvider.resolve(reference);
  }
  if (reference.kind === 'environment') {
    const value = host.environment.get(reference.name);
    if (value) return value;
    throw new DatagramError(
      'credential.environment-unset',
      `Credential environment variable ${reference.name} is unset or empty.`,
      400,
    );
  }
  try {
    const parsed = JSON.parse(await host.filesystem.readTextFile(reference.path)) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      reference.key in parsed &&
      typeof (parsed as Record<string, unknown>)[reference.key] === 'string' &&
      (parsed as Record<string, string>)[reference.key]
    ) {
      return (parsed as Record<string, string>)[reference.key] ?? '';
    }
  } catch {
    // Deliberately replace parser/filesystem details: they can contain secret material.
  }
  throw new DatagramError(
    'credential.file-unreadable',
    'Credential secret file is unavailable or invalid. Check its path, owner, and permissions.',
    400,
  );
}

function isCredentialReference(value: unknown): value is CredentialReference {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'native') {
    return (
      'provider' in value &&
      ['macos-keychain', 'linux-secret-service'].includes(String(value.provider)) &&
      'service' in value &&
      value.service === 'prosto-datagram' &&
      'account' in value &&
      typeof value.account === 'string' &&
      value.account.length > 0
    );
  }
  if (value.kind === 'environment') {
    return (
      'name' in value &&
      typeof value.name === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name)
    );
  }
  return (
    value.kind === 'file' &&
    'path' in value &&
    typeof value.path === 'string' &&
    isAbsolute(value.path) &&
    'key' in value &&
    typeof value.key === 'string' &&
    value.key.length > 0
  );
}

function isServerService(value: unknown): value is ServerServiceProfile['service'] {
  if (typeof value !== 'object' || value === null) return false;
  const service = value as Record<string, unknown>;
  const bind = service.bind as Record<string, unknown> | undefined;
  const postgres = service.postgres as Record<string, unknown> | undefined;
  const infrastructure = service.infrastructure as Record<string, unknown> | undefined;
  const publicAccess = service.publicAccess as Record<string, unknown> | undefined;
  const exposure = bind?.exposure;
  if (
    service.kind !== 'server' ||
    !['external-postgres', 'docker-postgres'].includes(String(infrastructure?.kind)) ||
    typeof service.serviceKey !== 'string' ||
    service.serviceKey.length === 0 ||
    !isCredentialReference(postgres?.credential) ||
    !['host', 'private', 'public'].includes(String(exposure)) ||
    typeof bind?.hostname !== 'string' ||
    bind.hostname.length === 0 ||
    typeof bind.port !== 'number' ||
    !Number.isInteger(bind.port) ||
    bind.port < 1 ||
    bind.port > 65_535
  ) return false;
  if (
    infrastructure?.kind === 'docker-postgres' &&
    (typeof infrastructure.image !== 'string' ||
      !infrastructure.image.startsWith('postgres:') ||
      typeof infrastructure.containerName !== 'string' ||
      infrastructure.containerName.length === 0 ||
      typeof infrastructure.volumeName !== 'string' ||
      infrastructure.volumeName.length === 0 ||
      typeof infrastructure.port !== 'number' ||
      !Number.isInteger(infrastructure.port) ||
      infrastructure.port < 1 ||
      infrastructure.port > 65_535)
  ) return false;
  if (exposure !== 'public') return publicAccess === undefined;
  return (
    (publicAccess?.kind === 'reverse-proxy' &&
      typeof publicAccess.endpoint === 'string' &&
      publicAccess.endpoint.startsWith('https://')) ||
    (publicAccess?.kind === 'direct-tls' &&
      typeof publicAccess.certificatePath === 'string' &&
      isAbsolute(publicAccess.certificatePath) &&
      typeof publicAccess.keyPath === 'string' &&
      isAbsolute(publicAccess.keyPath))
  );
}

export function parseProfile(value: string, expectedName?: string): ServiceProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidProfile('Service profile is not valid JSON. Run `datagram init` to repair it.');
  }
  const commonValid =
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('name' in parsed) ||
    typeof parsed.name !== 'string' ||
    !profileNamePattern.test(parsed.name) ||
    (expectedName !== undefined && parsed.name !== expectedName) ||
    !('service' in parsed) ||
    !('identity' in parsed) ||
    typeof parsed.identity !== 'object' ||
    parsed.identity === null ||
    !('personId' in parsed.identity) ||
    typeof parsed.identity.personId !== 'string' ||
    parsed.identity.personId.length === 0 ||
    !('displayName' in parsed.identity) ||
    typeof parsed.identity.displayName !== 'string';
  if (commonValid) {
    throw invalidProfile('Service profile is invalid. Run `datagram init` to repair it.');
  }
  const profile = parsed as Record<string, unknown>;
  const service = profile.service;
  const identity = profile.identity as Record<string, unknown>;
  const localValid =
    typeof service === 'object' &&
    service !== null &&
    'kind' in service &&
    service.kind === 'local' &&
    'databasePath' in service &&
    typeof service.databasePath === 'string' &&
    isAbsolute(service.databasePath);
  const serverValid =
    isServerService(service) &&
    'bearerCredential' in identity &&
    isCredentialReference(identity.bearerCredential);
  if (!localValid && !serverValid) {
    throw invalidProfile('Service profile is invalid. Run `datagram init` to repair it.');
  }
  return parsed as ServiceProfile;
}

function legacyDatabasePath(host: CliHost, value: string | undefined): string {
  if (value === ':memory:') return value;
  return resolve(host.currentDirectory, value ?? 'datagram.sqlite');
}

export async function readServiceProfile(
  host: CliHost,
  profileName: string,
): Promise<ServiceProfile> {
  if (!profileNamePattern.test(profileName)) {
    throw new DatagramError(
      'profile.name-invalid',
      'Profile name must use 1-64 letters, numbers, periods, underscores, or hyphens.',
      400,
    );
  }
  const profilePath = join(host.directories.configuration, 'profiles', `${profileName}.json`);
  if (!(await host.filesystem.pathExists(profilePath))) {
    throw new DatagramError(
      'profile.not-found',
      `Service profile ${JSON.stringify(profileName)} was not found. Run \`datagram init\` to create it.`,
      404,
    );
  }
  try {
    return parseProfile(await host.filesystem.readTextFile(profilePath), profileName);
  } catch (error) {
    if (error instanceof DatagramError) throw error;
    throw new DatagramError(
      'profile.unreadable',
      `Service profile ${JSON.stringify(profileName)} could not be read. Check its permissions or run \`datagram init\` to repair it.`,
      400,
    );
  }
}

export async function resolveServiceTarget(
  host: CliHost,
  options: TargetOptions,
): Promise<ResolvedServiceTarget> {
  const environmentDatabasePath = host.environment.get('DATAGRAM_DB');
  const environmentActorId = host.environment.get('DATAGRAM_ACTOR_ID');

  if (options.profileName !== undefined) {
    if (options.databasePath !== undefined || options.actorId !== undefined) {
      throw new DatagramError(
        'profile.target-conflict',
        '`--profile` cannot be combined with `--db` or `--actor`. Choose one Service target.',
        400,
      );
    }
    const profile = await readServiceProfile(host, options.profileName);
    if (profile.service.kind !== 'local') {
      throw new DatagramError(
        'profile.server-command-required',
        `Service profile ${JSON.stringify(profile.name)} targets a Server Service. Use \`datagram serve --profile ${profile.name}\` or \`datagram doctor --profile ${profile.name}\`.`,
        400,
      );
    }
    return {
      kind: 'local',
      actorId: profile.identity.personId,
      databasePath: profile.service.databasePath,
      profileName: profile.name,
    };
  }

  if (
    options.databasePath !== undefined ||
    options.actorId !== undefined ||
    environmentDatabasePath !== undefined ||
    environmentActorId !== undefined
  ) {
    const actorId = options.actorId ?? environmentActorId;
    return {
      kind: 'local',
      ...(actorId === undefined ? {} : { actorId }),
      databasePath: legacyDatabasePath(
        host,
        options.databasePath ?? environmentDatabasePath,
      ),
    };
  }

  const defaultProfilePath = join(host.directories.configuration, 'default-profile');
  if (!(await host.filesystem.pathExists(defaultProfilePath))) {
    throw new DatagramError(
      'profile.selection-required',
      'No default Service profile is configured. Run `datagram init` or select one with `--profile NAME`.',
      400,
    );
  }
  let defaultProfileName: string;
  try {
    defaultProfileName = (await host.filesystem.readTextFile(defaultProfilePath)).trim();
  } catch {
    throw new DatagramError(
      'profile.default-unreadable',
      'The default Service profile could not be read. Check its permissions or run `datagram init` to choose a default.',
      400,
    );
  }
  if (!profileNamePattern.test(defaultProfileName)) {
    throw invalidProfile(
      'The default Service profile selection is invalid. Run `datagram init` to choose a default.',
    );
  }
  const profile = await readServiceProfile(host, defaultProfileName);
  if (profile.service.kind !== 'local') {
    throw new DatagramError(
      'profile.server-command-required',
      `Default profile ${JSON.stringify(profile.name)} targets a Server Service. Select a Local Service profile for this command.`,
      400,
    );
  }
  return {
    kind: 'local',
    actorId: profile.identity.personId,
    databasePath: profile.service.databasePath,
    profileName: profile.name,
  };
}
