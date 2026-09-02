import { join } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { OpenDatagramRuntime } from '../../runtime';
import type { CliHost } from './host';
import {
  readServiceProfile,
  resolveServiceTarget,
  type ResolvedServiceTarget,
} from './profiles';

export type DoctorStage = 'profile' | 'target' | 'runtime' | 'identity';

interface SuccessfulCheck {
  readonly status: 'ok';
  readonly stage: DoctorStage;
}

export interface FailedDoctorCheck {
  readonly status: 'failed';
  readonly stage: DoctorStage;
  readonly code: string;
  readonly recovery: string;
  readonly context: Readonly<Record<string, string>>;
  readonly technicalContext: Readonly<Record<string, string>>;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly profileName: string;
  readonly checks: readonly (SuccessfulCheck | FailedDoctorCheck)[];
  readonly target?: ResolvedServiceTarget;
}

const stages: readonly DoctorStage[] = ['profile', 'target', 'runtime', 'identity'];

function repairCommand(profileName: string): string {
  return `Run \`bunx prosto-datagram init\` to repair profile ${JSON.stringify(profileName)}.`;
}

function causeCode(error: unknown): string {
  return error instanceof DatagramError ? error.code : 'internal';
}

function failed(
  profileName: string,
  stage: DoctorStage,
  code: string,
  recovery: string,
  context: Readonly<Record<string, string>>,
  technicalContext: Readonly<Record<string, string>>,
  completed: SuccessfulCheck[],
): DoctorReport {
  return {
    ok: false,
    profileName,
    checks: [...completed, { status: 'failed', stage, code, recovery, context, technicalContext }],
  };
}

export async function checkService(
  host: CliHost,
  profileName: string,
  existingRuntime?: OpenDatagramRuntime,
): Promise<DoctorReport> {
  const completed: SuccessfulCheck[] = [];
  const profilePath = join(host.directories.configuration, 'profiles', `${profileName}.json`);
  try {
    await readServiceProfile(host, profileName);
    completed.push({ status: 'ok', stage: 'profile' });
  } catch (error) {
    return failed(
      profileName,
      'profile',
      'doctor.profile-unreadable',
      repairCommand(profileName),
      { profile: profileName },
      { causeCode: causeCode(error), profilePath },
      completed,
    );
  }

  let target: ResolvedServiceTarget;
  try {
    target = await resolveServiceTarget(host, { profileName });
    completed.push({ status: 'ok', stage: 'target' });
  } catch (error) {
    return failed(
      profileName,
      'target',
      'doctor.target-unresolved',
      repairCommand(profileName),
      { profile: profileName },
      { causeCode: causeCode(error), profilePath },
      completed,
    );
  }

  let runtime = existingRuntime;
  let closeRuntime = false;
  try {
    if (!(await host.filesystem.pathExists(target.databasePath))) {
      throw new DatagramError('store.not-found', 'Configured Store does not exist.', 404);
    }
    if (runtime === undefined) {
      runtime = await host.openRuntime({ databasePath: target.databasePath });
      closeRuntime = true;
    }
    if (runtime.app.actions.catalog().length === 0) throw new Error('empty runtime catalog');
    completed.push({ status: 'ok', stage: 'runtime' });
  } catch (error) {
    if (closeRuntime && runtime !== undefined) await runtime.close();
    return failed(
      profileName,
      'runtime',
      'doctor.runtime-unready',
      repairCommand(profileName),
      { profile: profileName, service: 'local' },
      { adapter: 'sqlite', causeCode: causeCode(error), databasePath: target.databasePath },
      completed,
    );
  }

  try {
    await runtime.app.verifyServiceIdentity(target.actorId ?? '');
    completed.push({ status: 'ok', stage: 'identity' });
    return { ok: true, profileName, checks: completed, target };
  } catch (error) {
    return failed(
      profileName,
      'identity',
      'doctor.identity-invalid',
      repairCommand(profileName),
      { profile: profileName, service: 'local' },
      {
        causeCode: causeCode(error),
        databasePath: target.databasePath,
        identityReference: target.actorId === undefined ? 'missing' : 'configured',
      },
      completed,
    );
  } finally {
    if (closeRuntime) await runtime.close();
  }
}

function renderContext(context: Readonly<Record<string, string>>): string {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
}

export async function runDoctor(
  host: CliHost,
  profileName: string | undefined,
  verbose: boolean,
): Promise<void> {
  if (profileName === undefined) {
    throw new DatagramError('input.invalid', '`doctor` requires `--profile NAME`.', 400);
  }
  const report = await checkService(host, profileName);
  for (const stage of stages) {
    const check = report.checks.find((candidate) => candidate.stage === stage);
    if (check !== undefined) host.terminal.writeOutput(`${stage}: ${check.status}\n`);
  }
  if (report.ok) {
    host.terminal.writeOutput(
      `Service ready. profile=${JSON.stringify(profileName)} kind=local\nChannel data: not inspected\n`,
    );
    return;
  }

  const failure = report.checks.find(
    (check): check is FailedDoctorCheck => check.status === 'failed',
  );
  if (failure === undefined) throw new Error('Doctor report has no failure');
  host.terminal.writeOutput(
    `Code: ${failure.code}\nStage: ${failure.stage}\nContext: ${renderContext(failure.context)}\nRecovery: ${failure.recovery}\n`,
  );
  if (verbose) {
    host.terminal.writeOutput(`Technical context: ${renderContext(failure.technicalContext)}\n`);
  }
  host.setExitCode(1);
}
