import { isAbsolute, join, resolve } from 'node:path';

import { DatagramError } from '../../application/errors';
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
  readonly databasePath: string;
  readonly actorId?: string;
  readonly profileName?: string;
}

function invalidProfile(message: string): DatagramError {
  return new DatagramError('profile.invalid', message, 400);
}

export function parseProfile(value: string, expectedName?: string): LocalServiceProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidProfile('Service profile is not valid JSON. Run `datagram init` to repair it.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('name' in parsed) ||
    typeof parsed.name !== 'string' ||
    !profileNamePattern.test(parsed.name) ||
    (expectedName !== undefined && parsed.name !== expectedName) ||
    !('service' in parsed) ||
    typeof parsed.service !== 'object' ||
    parsed.service === null ||
    !('kind' in parsed.service) ||
    parsed.service.kind !== 'local' ||
    !('databasePath' in parsed.service) ||
    typeof parsed.service.databasePath !== 'string' ||
    !isAbsolute(parsed.service.databasePath) ||
    !('identity' in parsed) ||
    typeof parsed.identity !== 'object' ||
    parsed.identity === null ||
    !('personId' in parsed.identity) ||
    typeof parsed.identity.personId !== 'string' ||
    parsed.identity.personId.length === 0 ||
    !('displayName' in parsed.identity) ||
    typeof parsed.identity.displayName !== 'string'
  ) {
    throw invalidProfile('Service profile is invalid. Run `datagram init` to repair it.');
  }
  return parsed as LocalServiceProfile;
}

function legacyDatabasePath(host: CliHost, value: string | undefined): string {
  if (value === ':memory:') return value;
  return resolve(host.currentDirectory, value ?? 'datagram.sqlite');
}

export async function readServiceProfile(
  host: CliHost,
  profileName: string,
): Promise<LocalServiceProfile> {
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
    return {
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
  return {
    actorId: profile.identity.personId,
    databasePath: profile.service.databasePath,
    profileName: profile.name,
  };
}
