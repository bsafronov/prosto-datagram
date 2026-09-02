import { join } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { CliHost } from './host';
import type { StarterProgress } from './profiles';

export type JournalStarterProgress =
  | StarterProgress
  | { readonly status: 'channel-applying' }
  | {
      readonly status: 'field-applying';
      readonly channelId: string;
      readonly channelOperationId: string;
    }
  | {
      readonly status: 'record-applying';
      readonly channelId: string;
      readonly channelOperationId: string;
      readonly fieldOperationId: string;
    };

export interface SetupJournal {
  readonly version: 1;
  readonly profileName: string;
  readonly core: 'planned' | 'applied' | 'verified';
  readonly starter: JournalStarterProgress;
  readonly durableInstall: 'skipped' | 'pending' | 'verified';
  readonly codex?:
    | { readonly status: 'pending' | 'skill-installed' | 'verified' }
    | { readonly status: 'skipped' | 'unavailable'; readonly reason: string };
  readonly failure?: {
    readonly stage: 'core' | 'starter' | 'durable-install' | 'codex';
    readonly code: string;
  };
}

function validCodex(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || !('status' in value)) return false;
  const item = value as Record<string, unknown>;
  if (['pending', 'skill-installed', 'verified'].includes(String(item.status))) {
    return hasOnlyKeys(item, ['status']);
  }
  return (
    ['skipped', 'unavailable'].includes(String(item.status)) &&
    typeof item.reason === 'string' &&
    hasOnlyKeys(item, ['status', 'reason'])
  );
}

export function setupJournalPath(host: CliHost, profileName: string): string {
  return join(host.directories.configuration, 'setup-journals', `${profileName}.json`);
}

function isControlId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validStarter(value: unknown): value is JournalStarterProgress {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false;
  const item = value as Record<string, unknown>;
  if (item.status === 'pending' || item.status === 'channel-applying') {
    return hasOnlyKeys(item, ['status']);
  }
  if (!isControlId(item.channelId) || !isControlId(item.channelOperationId)) return false;
  if (item.status === 'channel-created' || item.status === 'field-applying') {
    return hasOnlyKeys(item, ['status', 'channelId', 'channelOperationId']);
  }
  if (!isControlId(item.fieldOperationId)) return false;
  if (item.status === 'field-created' || item.status === 'record-applying') {
    return hasOnlyKeys(item, [
      'status',
      'channelId',
      'channelOperationId',
      'fieldOperationId',
    ]);
  }
  return (
    item.status === 'complete' &&
    isControlId(item.recordOperationId) &&
    hasOnlyKeys(item, [
      'status',
      'channelId',
      'channelOperationId',
      'fieldOperationId',
      'recordOperationId',
    ])
  );
}

export function parseSetupJournal(value: string, expectedProfileName: string): SetupJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DatagramError('setup.journal-invalid', 'Setup journal is not valid JSON.', 400);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DatagramError('setup.journal-invalid', 'Setup journal is invalid.', 400);
  }
  const journal = parsed as Record<string, unknown>;
  const failure = journal.failure;
  if (
    !hasOnlyKeys(journal, [
      'version',
      'profileName',
      'core',
      'starter',
      'durableInstall',
      'codex',
      'failure',
    ]) ||
    journal.version !== 1 ||
    journal.profileName !== expectedProfileName ||
    !['planned', 'applied', 'verified'].includes(String(journal.core)) ||
    !validStarter(journal.starter) ||
    !['skipped', 'pending', 'verified'].includes(String(journal.durableInstall)) ||
    !validCodex(journal.codex) ||
    (failure !== undefined &&
      (typeof failure !== 'object' ||
        failure === null ||
        !hasOnlyKeys(failure as Record<string, unknown>, ['stage', 'code']) ||
        !['core', 'starter', 'durable-install', 'codex'].includes(String((failure as Record<string, unknown>).stage)) ||
        !isControlId((failure as Record<string, unknown>).code)))
  ) {
    throw new DatagramError('setup.journal-invalid', 'Setup journal is invalid.', 400);
  }
  return parsed as SetupJournal;
}

export async function readSetupJournal(
  host: CliHost,
  profileName: string,
): Promise<SetupJournal | undefined> {
  const path = setupJournalPath(host, profileName);
  if (!(await host.filesystem.pathExists(path))) return undefined;
  return parseSetupJournal(await host.filesystem.readTextFile(path), profileName);
}

export async function saveSetupJournal(host: CliHost, journal: SetupJournal): Promise<void> {
  const directory = join(host.directories.configuration, 'setup-journals');
  await host.filesystem.makeDirectory(directory, { recursive: true });
  await host.filesystem.writeTextFileAtomic(
    setupJournalPath(host, journal.profileName),
    `${JSON.stringify(journal, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function isUncertainStarter(
  progress: JournalStarterProgress,
): progress is Extract<JournalStarterProgress, { readonly status: `${string}-applying` }> {
  return progress.status.endsWith('-applying');
}
