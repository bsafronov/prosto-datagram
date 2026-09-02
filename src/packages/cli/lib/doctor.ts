import { join } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { OpenDatagramRuntime } from '../../runtime';
import type { CliHost } from './host';
import { verifyCodexIntegration } from './integrations';
import { readSetupJournal } from './journal';
import {
  readServiceProfile,
  isServerProfile,
  resolveCredential,
  resolveServiceTarget,
  type ResolvedServiceTarget,
  type ServerServiceProfile,
} from './profiles';

export type DoctorStage = 'profile' | 'target' | 'runtime' | 'identity' | 'codex';

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
  readonly serviceKind: 'local' | 'server';
  readonly checks: readonly (SuccessfulCheck | FailedDoctorCheck)[];
  readonly target?: ResolvedServiceTarget;
}

const stages: readonly DoctorStage[] = ['profile', 'target', 'runtime', 'identity', 'codex'];

function repairCommand(profileName: string): string {
  return `Run \`bunx prosto-datagram init --profile ${JSON.stringify(profileName)}\` to repair this profile.`;
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
  serviceKind: 'local' | 'server' = 'local',
): DoctorReport {
  return {
    ok: false,
    profileName,
    serviceKind,
    checks: [...completed, { status: 'failed', stage, code, recovery, context, technicalContext }],
  };
}

async function checkCodex(
  host: CliHost,
  profileName: string,
  serviceKind: 'local' | 'server',
  completed: SuccessfulCheck[],
): Promise<DoctorReport | undefined> {
  const journal = await readSetupJournal(host, profileName).catch(() => undefined);
  if (
    journal?.codex?.status !== 'skill-installed' &&
    journal?.codex?.status !== 'verified' &&
    journal?.failure?.stage !== 'codex'
  ) {
    return undefined;
  }
  const integration = await verifyCodexIntegration(host, profileName);
  if (!integration.ok) {
    return failed(
      profileName,
      'codex',
      'doctor.codex-unready',
      `Run \`bunx prosto-datagram init --profile ${JSON.stringify(profileName)}\` to resume Connect Codex.`,
      { profile: profileName, integration: 'codex' },
      { reason: integration.reason ?? 'verification failed' },
      completed,
      serviceKind,
    );
  }
  completed.push({ status: 'ok', stage: 'codex' });
  return undefined;
}

async function checkServerService(
  host: CliHost,
  profile: ServerServiceProfile,
  completed: SuccessfulCheck[],
  existing?: {
    readonly connectionString: string;
    readonly bearerToken: string;
    readonly started: Awaited<ReturnType<NonNullable<CliHost['startServerService']>>>;
  },
): Promise<DoctorReport> {
  let connectionString: string;
  let bearerToken: string;
  try {
    connectionString = existing?.connectionString ?? await resolveCredential(host, profile.service.postgres.credential);
    bearerToken = existing?.bearerToken ?? await resolveCredential(host, profile.identity.bearerCredential);
    completed.push({ status: 'ok', stage: 'target' });
  } catch (error) {
    return failed(
      profile.name,
      'target',
      'doctor.target-unresolved',
      repairCommand(profile.name),
      { profile: profile.name, service: 'server' },
      { causeCode: causeCode(error), credentialReferences: 'configured' },
      completed,
      'server',
    );
  }
  try {
    if (profile.service.infrastructure.kind === 'docker-postgres') {
      if (host.dockerPostgres === undefined || !(await host.dockerPostgres.available())) {
        throw new Error('docker unavailable');
      }
      const state = await host.dockerPostgres.status({
        profileName: profile.name,
        ...profile.service.infrastructure,
      });
      if (state !== 'running') throw new Error(`managed postgres ${state}`);
    }
    if (host.probePostgres === undefined) throw new Error('probe unavailable');
    await host.probePostgres(connectionString);
    completed.push({ status: 'ok', stage: 'runtime' });
  } catch {
    return failed(
      profile.name,
      'runtime',
      'doctor.runtime-unready',
      profile.service.infrastructure.kind === 'docker-postgres'
        ? `Run \`bunx prosto-datagram postgres start --profile ${JSON.stringify(profile.name)}\`, then retry.`
        : 'Check PostgreSQL availability, TLS mode, credentials, and network route.',
      { profile: profile.name, service: 'server' },
      {
        adapter:
          profile.service.infrastructure.kind === 'docker-postgres' ? 'docker-postgres' : 'postgres',
        credentialReference: 'configured',
      },
      completed,
      'server',
    );
  }
  let started = existing?.started;
  const startedHere = started === undefined;
  try {
    if (host.startServerService === undefined || host.request === undefined) {
      throw new Error('server verification unavailable');
    }
    if (started === undefined) {
      started = await host.startServerService({
        connectionString,
        deploymentOperatorDisplayName: profile.identity.displayName,
        deploymentOperatorId: profile.identity.personId,
        deploymentOperatorToken: bearerToken,
        hostname: profile.service.bind.hostname,
        port: profile.service.bind.port,
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
    }
    const url =
      profile.service.publicAccess?.kind === 'reverse-proxy'
        ? new URL(profile.service.publicAccess.endpoint)
        : started.server.url;
    const health = await host.request(
      new Request(new URL('/health', url), {
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      }),
    );
    const actions = await host.request(
      new Request(new URL('/v1/actions', url), {
        headers: { authorization: `Bearer ${bearerToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      }),
    );
    if (!health.ok || !actions.ok) throw new Error('verification failed');
    completed.push({ status: 'ok', stage: 'identity' });
    const codexFailure = await checkCodex(host, profile.name, 'server', completed);
    if (codexFailure !== undefined) return codexFailure;
    return {
      ok: true,
      profileName: profile.name,
      serviceKind: 'server',
      checks: completed,
    };
  } catch {
    return failed(
      profile.name,
      'identity',
      'doctor.identity-invalid',
      'Check the bind address, TLS/reverse proxy, and Deployment Operator credential.',
      { profile: profile.name, service: 'server' },
      { identityReference: 'configured', networkExposure: profile.service.bind.exposure },
      completed,
      'server',
    );
  } finally {
    if (startedHere && started) {
      await started.server.stop();
      await started.runtime.close();
    }
  }
}

export async function checkService(
  host: CliHost,
  profileName: string,
  existingRuntime?: OpenDatagramRuntime,
  existingServer?: {
    readonly connectionString: string;
    readonly bearerToken: string;
    readonly started: Awaited<ReturnType<NonNullable<CliHost['startServerService']>>>;
  },
): Promise<DoctorReport> {
  const completed: SuccessfulCheck[] = [];
  const profilePath = join(host.directories.configuration, 'profiles', `${profileName}.json`);
  try {
    const profile = await readServiceProfile(host, profileName);
    completed.push({ status: 'ok', stage: 'profile' });
    if (isServerProfile(profile)) return checkServerService(host, profile, completed, existingServer);
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

  const codexFailure = await checkCodex(host, profileName, 'local', completed);
  if (codexFailure !== undefined) return codexFailure;
  return { ok: true, profileName, serviceKind: 'local', checks: completed, target };
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
      `Service ready. profile=${JSON.stringify(profileName)} kind=${report.serviceKind}\nChannel data: not inspected\n`,
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
