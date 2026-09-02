import { isAbsolute, join } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { ServerServiceOptions } from '../../server';
import type { CliHost } from './host';
import type { CredentialReference } from './credentials';
import { applyCodexIntegration, discoverCodexIntegration } from './integrations';
import { saveSetupJournal, type SetupJournal } from './journal';
import {
  managedPostgresDefinition,
  type ManagedPostgresCreate,
} from './docker-postgres';
import {
  parseProfile,
  profileNamePattern,
  type ServerExposure,
  type ServerServiceProfile,
} from './profiles';

type ReadAnswer = () => Promise<string>;
type PublicAccess = ServerServiceProfile['service']['publicAccess'];

interface Answers {
  readonly profileName: string;
  readonly displayName: string;
  readonly connectionString: string;
  readonly credentialStorage: 'native' | 'file' | 'environment';
  readonly postgresCredential?: CredentialReference;
  readonly bearerToken: string;
  readonly bearerCredential?: CredentialReference;
  readonly secretPath?: string;
  readonly exposure: ServerExposure;
  readonly hostname: string;
  readonly port: number;
  readonly publicAccess?: PublicAccess;
  readonly managedPostgres?: ManagedPostgresCreate;
  readonly managedCredentialsReused?: boolean;
}

const envPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const trim = (value: string) => value.trim();
const isCancel = (value: string) => trim(value).toLowerCase() === 'cancel';

function capability<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new DatagramError(code, 'Setup is unavailable on this host.', 500);
  return value;
}

function postgresUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatagramError('setup.postgres-url-invalid', 'Enter a valid PostgreSQL URL.', 400);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname === '/') {
    throw new DatagramError(
      'setup.postgres-url-invalid',
      'PostgreSQL URL must include a host and database.',
      400,
    );
  }
  const sslMode = (url.searchParams.get('sslmode') ?? 'default').toLowerCase();
  const local = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
  if (!local && ['disable', 'allow', 'prefer'].includes(sslMode)) {
    throw new DatagramError(
      'setup.postgres-tls-required',
      'Remote PostgreSQL must use sslmode=require, verify-ca, or verify-full.',
      400,
    );
  }
  return url;
}

function managedPostgresFromUrl(profileName: string, value: string): ManagedPostgresCreate {
  const url = postgresUrl(value);
  const port = Number(url.port || '5432');
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()) ||
    url.username !== 'datagram' ||
    url.pathname !== '/datagram' ||
    !url.password ||
    !Number.isInteger(port)
  ) {
    throw new DatagramError(
      'setup.managed-credential-invalid',
      'Existing managed PostgreSQL credentials are invalid. Repair them explicitly; no data was changed.',
      400,
    );
  }
  return {
    ...managedPostgresDefinition(profileName, port),
    password: decodeURIComponent(url.password),
  };
}

async function envSecret(
  host: CliHost,
  read: ReadAnswer,
  label: string,
  defaultName: string,
): Promise<{ reference: CredentialReference; value: string }> {
  host.terminal.writeOutput(`${label} environment variable [${defaultName}] (or Cancel): `);
  const answer = trim(await read());
  if (isCancel(answer)) throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
  const name = answer || defaultName;
  if (!envPattern.test(name)) {
    throw new DatagramError('setup.environment-invalid', 'Environment variable name is invalid.', 400);
  }
  const value = host.environment.get(name);
  if (!value) {
    throw new DatagramError(
      'setup.environment-unset',
      `Environment variable ${name} is unset or empty.`,
      400,
    );
  }
  return { reference: { kind: 'environment', name }, value };
}

async function collect(host: CliHost, read: ReadAnswer): Promise<Answers> {
  host.terminal.writeOutput('[2/9] Team Service profile name [team] (or Cancel): ');
  const rawProfileName = trim(await read());
  if (isCancel(rawProfileName)) throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
  const profileName = rawProfileName || 'team';
  if (!profileNamePattern.test(profileName)) {
    throw new DatagramError('profile.name-invalid', 'Service profile name is invalid.', 400);
  }
  host.terminal.writeOutput('[3/9] Deployment Operator display name (or Cancel): ');
  const displayName = trim(await read());
  if (isCancel(displayName)) throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
  if (!displayName || displayName.length > 120) {
    throw new DatagramError('setup.display-name-invalid', 'Enter 1-120 characters.', 400);
  }
  host.terminal.writeOutput(
    '[4/9] PostgreSQL\n  1. Existing PostgreSQL URL (externally owned)\n' +
      '  2. Docker-managed persistent PostgreSQL\nSelection [1] (or Cancel): ',
  );
  const databaseSource = trim(await read());
  if (isCancel(databaseSource)) throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
  if (!['', '1', '2'].includes(databaseSource)) {
    throw new DatagramError('setup.postgres-choice-invalid', 'Choose 1 or 2.', 400);
  }
  const managed = databaseSource === '2';
  let connectionString: string | undefined;
  let bearerToken: string | undefined;
  let postgresCredential: CredentialReference | undefined;
  let bearerCredential: CredentialReference | undefined;
  let secretPath: string | undefined;
  let credentialStorage: Answers['credentialStorage'];
  let managedPostgres: ManagedPostgresCreate | undefined;
  let managedCredentialsReused = false;
  if (managed) {
    host.terminal.writeOutput('PostgreSQL host port [5432] (or Cancel): ');
    const rawPostgresPort = trim(await read());
    if (isCancel(rawPostgresPort)) throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
    const postgresPort = rawPostgresPort ? Number(rawPostgresPort) : 5432;
    if (!Number.isInteger(postgresPort) || postgresPort < 1 || postgresPort > 65_535) {
      throw new DatagramError('setup.port-invalid', 'Port must be from 1 to 65535.', 400);
    }
    const password = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    bearerToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    connectionString = `postgres://datagram:${password}@127.0.0.1:${postgresPort}/datagram?sslmode=disable`;
    managedPostgres = { ...managedPostgresDefinition(profileName, postgresPort), password };
  }
  const nativeAvailability =
    host.credentialProvider === undefined
      ? {
          available: false as const,
          reason: 'Native credential storage is unsupported on this platform.',
        }
      : await host.credentialProvider.availability();
  host.terminal.writeOutput('Credentials\n');
  if (nativeAvailability.available) {
    host.terminal.writeOutput(
      `  1. System credential store (${host.credentialProvider?.kind}) (Recommended)\n` +
        '  2. Permission-restricted secret file\n' +
        (managed ? '' : '  3. Environment references (Advanced)\n') +
        'Selection [1] (or Cancel): ',
    );
  } else {
    host.terminal.writeOutput(
      `  System credential store unavailable: ${nativeAvailability.reason}\n` +
        'Choose an explicit fallback:\n' +
        '  1. Permission-restricted secret file (Recommended fallback)\n' +
        (managed ? '' : '  2. Environment references (Advanced)\n') +
        'Selection [1] (or Cancel): ',
    );
  }
  const storage = trim(await read());
  if (isCancel(storage)) throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
  const nativeSelected = nativeAvailability.available && (!storage || storage === '1');
  const fileSelected = nativeAvailability.available ? storage === '2' : !storage || storage === '1';
  const environmentSelected =
    !managed && (nativeAvailability.available ? storage === '3' : storage === '2');
  if (nativeSelected || fileSelected) {
    credentialStorage = nativeSelected ? 'native' : 'file';
    if (!managed) {
      host.terminal.writeOutput('Existing PostgreSQL URL (or Cancel): ');
      connectionString = trim(await read());
      if (isCancel(connectionString)) {
        throw new DatagramError('setup.cancelled', 'Setup cancelled.', 400);
      }
      bearerToken =
        crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    }
    if (fileSelected) {
      secretPath = join(host.directories.configuration, 'secrets', `${profileName}.json`);
      postgresCredential = { kind: 'file', path: secretPath, key: 'postgresUrl' };
      bearerCredential = { kind: 'file', path: secretPath, key: 'bearerToken' };
      if (managed && (await host.filesystem.pathExists(secretPath))) {
        try {
          const stored = JSON.parse(await host.filesystem.readTextFile(secretPath)) as Record<
            string,
            unknown
          >;
          if (typeof stored.postgresUrl !== 'string' || typeof stored.bearerToken !== 'string') {
            throw new Error('missing credential');
          }
          managedPostgres = managedPostgresFromUrl(profileName, stored.postgresUrl);
          connectionString = stored.postgresUrl;
          bearerToken = stored.bearerToken;
          managedCredentialsReused = true;
        } catch (error) {
          if (error instanceof DatagramError) throw error;
          throw new DatagramError(
            'setup.managed-credential-invalid',
            'Existing managed PostgreSQL credentials are invalid. Repair them explicitly; no data was changed.',
            400,
          );
        }
      }
    } else if (managed) {
      const provider = capability(host.credentialProvider, 'credential.native-unavailable');
      const postgresReference = {
        kind: 'native' as const,
        provider: provider.kind,
        service: 'prosto-datagram' as const,
        account: `${profileName}:postgres`,
      };
      const bearerReference = { ...postgresReference, account: `${profileName}:operator` };
      try {
        const stored = await Promise.all([
          provider.resolve(postgresReference),
          provider.resolve(bearerReference),
        ]);
        managedPostgres = managedPostgresFromUrl(profileName, stored[0]);
        connectionString = stored[0];
        bearerToken = stored[1];
        postgresCredential = postgresReference;
        bearerCredential = bearerReference;
        managedCredentialsReused = true;
      } catch {
        // Missing credentials are created only after review; existing infrastructure is checked first.
      }
    }
  } else if (environmentSelected) {
    credentialStorage = 'environment';
    const pg = await envSecret(host, read, 'PostgreSQL URL', 'DATAGRAM_POSTGRES_URL');
    const bearer = await envSecret(host, read, 'Operator bearer token', 'DATAGRAM_OPERATOR_TOKEN');
    connectionString = pg.value;
    bearerToken = bearer.value;
    postgresCredential = pg.reference;
    bearerCredential = bearer.reference;
  } else {
    throw new DatagramError(
      'setup.credential-choice-invalid',
      nativeAvailability.available && !managed ? 'Choose 1, 2, or 3.' : 'Choose 1 or 2.',
      400,
    );
  }
  if (connectionString === undefined || bearerToken === undefined) {
    throw new DatagramError('credential.value-missing', 'Credential values were not created.', 500);
  }
  postgresUrl(connectionString);
  host.terminal.writeOutput(
    '[6/9] Exposure\n  1. This host\n  2. Private network\n  3. Public\nSelection [1]: ',
  );
  const exposureAnswer = trim(await read());
  const exposure: ServerExposure =
    !exposureAnswer || exposureAnswer === '1'
      ? 'host'
      : exposureAnswer === '2'
        ? 'private'
        : exposureAnswer === '3'
          ? 'public'
          : (() => {
              throw new DatagramError('setup.exposure-invalid', 'Choose 1, 2, or 3.', 400);
            })();
  let hostname = '127.0.0.1';
  if (exposure !== 'host') {
    host.terminal.writeOutput('Explicit non-loopback bind hostname/address: ');
    hostname = trim(await read());
    if (!hostname || ['127.0.0.1', '::1', 'localhost'].includes(hostname.toLowerCase())) {
      throw new DatagramError('setup.bind-invalid', 'Enter an explicit non-loopback bind address.', 400);
    }
  }
  let publicAccess: PublicAccess;
  if (exposure === 'public') {
    host.terminal.writeOutput(
      '[7/9] Public TLS\n  1. Existing HTTPS reverse proxy\n' +
        '  2. Direct TLS certificate/key\nSelection: ',
    );
    const tls = trim(await read());
    if (tls === '1') {
      host.terminal.writeOutput('Public HTTPS endpoint: ');
      const endpoint = trim(await read());
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new DatagramError('setup.public-tls-required', 'Enter a valid HTTPS endpoint.', 400);
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new DatagramError(
          'setup.public-tls-required',
          'Public exposure requires a credential-free HTTPS endpoint.',
          400,
        );
      }
      publicAccess = { kind: 'reverse-proxy', endpoint: url.toString() };
    } else if (tls === '2') {
      host.terminal.writeOutput('Absolute TLS certificate path: ');
      const certificatePath = trim(await read());
      host.terminal.writeOutput('Absolute TLS private-key path: ');
      const keyPath = trim(await read());
      if (!isAbsolute(certificatePath) || !isAbsolute(keyPath)) {
        throw new DatagramError('setup.public-tls-required', 'TLS paths must be absolute.', 400);
      }
      if (!(await host.filesystem.pathExists(certificatePath)) || !(await host.filesystem.pathExists(keyPath))) {
        throw new DatagramError('setup.public-tls-required', 'TLS certificate or key was not found.', 400);
      }
      publicAccess = { kind: 'direct-tls', certificatePath, keyPath };
    } else {
      throw new DatagramError(
        'setup.public-tls-required',
        'Public exposure requires TLS or an HTTPS reverse proxy.',
        400,
      );
    }
  }
  host.terminal.writeOutput('[8/9] HTTP port [3100]: ');
  const rawPort = trim(await read());
  const port = rawPort ? Number(rawPort) : 3100;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DatagramError('setup.port-invalid', 'Port must be from 1 to 65535.', 400);
  }
  return {
    profileName,
    displayName,
    connectionString,
    credentialStorage,
    ...(postgresCredential === undefined ? {} : { postgresCredential }),
    bearerToken,
    ...(bearerCredential === undefined ? {} : { bearerCredential }),
    ...(secretPath ? { secretPath } : {}),
    exposure,
    hostname,
    port,
    ...(publicAccess ? { publicAccess } : {}),
    ...(managedPostgres ? { managedPostgres } : {}),
    ...(managed ? { managedCredentialsReused } : {}),
  };
}

async function verifyHttp(host: CliHost, url: URL, token: string): Promise<void> {
  const request = capability(host.request, 'setup.http-probe-unavailable');
  for (const [path, authenticated] of [
    ['/health', false],
    ['/v1/actions', true],
  ] as const) {
    const response = await request(
      new Request(new URL(path, url), {
        ...(authenticated ? { headers: { authorization: `Bearer ${token}` } } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      }),
    );
    if (!response.ok) throw new Error('HTTP verification failed');
  }
}

async function probePostgresReady(host: CliHost, connectionString: string): Promise<void> {
  const probe = capability(host.probePostgres, 'setup.postgres-probe-unavailable');
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await probe(connectionString);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(250);
    }
  }
}

export async function runGuidedServerSetup(host: CliHost, read: ReadAnswer): Promise<void> {
  let answers: Answers;
  try {
    answers = await collect(host, read);
  } catch (error) {
    if (error instanceof DatagramError && error.code === 'setup.cancelled') {
      host.terminal.writeOutput('Setup cancelled. No changes were made.\n');
      return;
    }
    throw error;
  }
  host.terminal.writeOutput('Preflight: PostgreSQL infrastructure and HTTP port.\n');
  if (answers.managedPostgres) {
    let managedPostgres = answers.managedPostgres;
    const docker = capability(host.dockerPostgres, 'setup.docker-probe-unavailable');
    if (!(await docker.available())) {
      throw new DatagramError(
        'setup.docker-unavailable',
        'Docker is unavailable. Install or start Docker yourself, then retry; or choose an existing PostgreSQL URL. Docker was not installed.',
        400,
      );
    }
    let state = await docker.status(managedPostgres);
    if (state !== 'missing' && !answers.managedCredentialsReused) {
      throw new DatagramError(
        'setup.managed-credential-unavailable',
        'Managed PostgreSQL already exists, but its credentials could not be recovered. Repair credentials explicitly; no data was changed.',
        400,
      );
    }
    while (state === 'missing') {
      try {
        if (managedPostgres.port === answers.port) throw new Error('ports overlap');
        await capability(host.checkPort, 'setup.port-check-unavailable')(
          '127.0.0.1',
          managedPostgres.port,
        );
        break;
      } catch {
        host.terminal.writeOutput(
          `PostgreSQL port ${managedPostgres.port} is unavailable. Choose another port before Apply (or Cancel): `,
        );
        const replacement = trim(await read());
        if (isCancel(replacement)) {
          host.terminal.writeOutput('Setup cancelled. No changes were made.\n');
          return;
        }
        const port = Number(replacement);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new DatagramError('setup.port-invalid', 'Port must be from 1 to 65535.', 400);
        }
        const password = managedPostgres.password;
        managedPostgres = { ...managedPostgresDefinition(answers.profileName, port), password };
        answers = {
          ...answers,
          connectionString: `postgres://datagram:${password}@127.0.0.1:${port}/datagram?sslmode=disable`,
          managedPostgres,
        };
        state = await docker.status(managedPostgres);
      }
    }
  } else {
    try {
      await capability(host.probePostgres, 'setup.postgres-probe-unavailable')(
        answers.connectionString,
      );
    } catch {
      throw new DatagramError(
        'setup.postgres-unreachable',
        'PostgreSQL is unreachable. Check URL, TLS, permissions, and network route.',
        400,
      );
    }
  }
  const parsedUrl = postgresUrl(answers.connectionString);
  try {
    await capability(host.checkPort, 'setup.port-check-unavailable')(answers.hostname, answers.port);
  } catch {
    throw new DatagramError(
      'setup.port-unavailable',
      `HTTP port ${answers.port} is unavailable on the selected bind address.`,
      400,
    );
  }
  const profilePath = join(host.directories.configuration, 'profiles', `${answers.profileName}.json`);
  host.terminal.writeOutput(
    '[9/9] Review plan\n' +
      (answers.managedPostgres
        ? '  Service: Server Service; Docker-managed PostgreSQL owned by this profile\n' +
          `  Image download: ${answers.managedPostgres.image}\n` +
          `  Generated infrastructure: container=${answers.managedPostgres.containerName}; volume=${answers.managedPostgres.volumeName}\n` +
          `  PostgreSQL port: 127.0.0.1:${answers.managedPostgres.port}\n` +
          `  Data location: persistent Docker volume ${answers.managedPostgres.volumeName}\n` +
          '  Lifecycle: stop, repair, reconfiguration, and setup reruns never remove database data\n'
        : '  Service: Server Service; external PostgreSQL (no infrastructure lifecycle ownership)\n') +
      `  PostgreSQL: postgresql://[redacted]:${parsedUrl.port || '5432'}/[redacted] sslmode=${parsedUrl.searchParams.get('sslmode') ?? 'default'}\n` +
      `  Profile: ${answers.profileName} (default)\n` +
      `  Deployment Operator: ${answers.displayName}\n` +
      `  Exposure: ${answers.exposure}; bind=${answers.hostname}:${answers.port}\n` +
      `  Credentials: ${answers.credentialStorage === 'native' ? `system credential store (${host.credentialProvider?.kind})` : answers.credentialStorage === 'file' ? 'permission-restricted secret file' : 'environment references (Advanced)'}\n` +
      'Apply this plan? [Y/n] (or Cancel): ',
  );
  const consent = trim(await read()).toLowerCase();
  if (isCancel(consent) || consent === 'n' || consent === 'no') {
    host.terminal.writeOutput('Setup cancelled. No changes were made.\n');
    return;
  }
  if (!['', 'y', 'yes'].includes(consent)) {
    throw new DatagramError('setup.consent-invalid', 'Choose Y, n, or Cancel.', 400);
  }
  await host.filesystem.makeDirectory(join(host.directories.configuration, 'profiles'), { recursive: true });
  let postgresCredential = answers.postgresCredential;
  let bearerCredential = answers.bearerCredential;
  if (answers.credentialStorage === 'native') {
    const provider = capability(host.credentialProvider, 'credential.native-unavailable');
    const accountPrefix = answers.managedPostgres
      ? answers.profileName
      : `${answers.profileName}:${crypto.randomUUID()}`;
    postgresCredential = await provider.create({
      account: `${accountPrefix}:postgres`,
      label: `Prosto.Datagram ${answers.profileName} PostgreSQL`,
      secret: answers.connectionString,
    });
    bearerCredential = await provider.create({
      account: `${accountPrefix}:operator`,
      label: `Prosto.Datagram ${answers.profileName} operator`,
      secret: answers.bearerToken,
    });
  }
  if (postgresCredential === undefined || bearerCredential === undefined) {
    throw new DatagramError('credential.reference-missing', 'Credential references were not created.', 500);
  }
  if (answers.secretPath) {
    const secret = `${JSON.stringify({ postgresUrl: answers.connectionString, bearerToken: answers.bearerToken })}\n`;
    if (host.filesystem.writePrivateTextFile) {
      await host.filesystem.writePrivateTextFile(answers.secretPath, secret);
    } else {
      await host.filesystem.makeDirectory(join(host.directories.configuration, 'secrets'), { recursive: true });
      await host.filesystem.writeTextFile(answers.secretPath, secret, { mode: 0o600 });
    }
  }
  const existing = (await host.filesystem.pathExists(profilePath))
    ? parseProfile(await host.filesystem.readTextFile(profilePath), answers.profileName)
    : undefined;
  const serviceKey =
    existing?.service.kind === 'server' ? existing.service.serviceKey : `service_${crypto.randomUUID()}`;
  let started: Awaited<ReturnType<NonNullable<CliHost['startServerService']>>> | undefined;
  try {
    if (answers.managedPostgres) {
      await capability(host.dockerPostgres, 'setup.docker-probe-unavailable').ensure(
        answers.managedPostgres,
      );
      await probePostgresReady(host, answers.connectionString);
    }
    const options: ServerServiceOptions = {
      connectionString: answers.connectionString,
      deploymentOperatorDisplayName: answers.displayName,
      ...(existing?.service.kind === 'server'
        ? { deploymentOperatorId: existing.identity.personId }
        : {}),
      deploymentOperatorToken: answers.bearerToken,
      hostname: answers.hostname,
      port: answers.port,
      serviceKey,
      ...(answers.publicAccess?.kind === 'direct-tls'
        ? {
            tls: {
              certificate: await host.filesystem.readTextFile(answers.publicAccess.certificatePath),
              key: await host.filesystem.readTextFile(answers.publicAccess.keyPath),
            },
          }
        : {}),
    };
    started = await capability(host.startServerService, 'setup.server-start-unavailable')(options);
    const profile: ServerServiceProfile = {
      version: 1,
      name: answers.profileName,
      service: {
        kind: 'server',
        infrastructure: answers.managedPostgres
          ? {
              kind: 'docker-postgres',
              image: answers.managedPostgres.image,
              containerName: answers.managedPostgres.containerName,
              volumeName: answers.managedPostgres.volumeName,
              port: answers.managedPostgres.port,
            }
          : { kind: 'external-postgres' },
        serviceKey,
        postgres: { credential: postgresCredential },
        bind: { exposure: answers.exposure, hostname: answers.hostname, port: answers.port },
        ...(answers.publicAccess ? { publicAccess: answers.publicAccess } : {}),
      },
      identity: {
        personId: started.runtime.deploymentOperator.id,
        displayName: started.runtime.deploymentOperator.displayName,
        bearerCredential,
      },
    };
    await host.filesystem.writeTextFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    await host.filesystem.writeTextFile(
      join(host.directories.configuration, 'default-profile'),
      `${answers.profileName}\n`,
      { mode: 0o600 },
    );
    const verificationUrl =
      answers.publicAccess?.kind === 'reverse-proxy'
        ? new URL(answers.publicAccess.endpoint)
        : started.server.url;
    await verifyHttp(host, verificationUrl, answers.bearerToken);
    await host.filesystem.writeTextFile(
      profilePath,
      `${JSON.stringify({ ...profile, setup: { core: 'verified' } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    let journal: SetupJournal = {
      version: 1,
      profileName: answers.profileName,
      core: 'verified',
      starter: { status: 'pending' },
      durableInstall: 'skipped',
      codex: { status: 'pending' },
    };
    const discovery = await discoverCodexIntegration(host, answers.profileName, true);
    let codexSummary: string;
    if (!discovery.available) {
      journal = {
        ...journal,
        codex: { status: 'unavailable', reason: discovery.reason },
      };
      codexSummary = `unavailable (${discovery.reason})`;
      host.terminal.writeOutput(`Connect Codex unavailable: ${discovery.reason}.\n`);
    } else {
      const plan = discovery.plan;
      host.terminal.writeOutput(
        '[optional] Connect Codex\n' +
          `  Skill: install Datagram-owned files at ${plan.skillDestination}\n` +
          `  MCP: codex mcp add ${plan.mcpServerName} -- ${plan.command} --profile ${JSON.stringify(plan.profileName)}\n` +
          `  Credential reference: ${plan.credentialReference}\n` +
          '  Authority: selected person; Store-derived values remain outside agent output\n' +
          'Connect Codex now? [y/N]: ',
      );
      const connect = trim(await read()).toLowerCase();
      if (connect !== 'y' && connect !== 'yes') {
        journal = { ...journal, codex: { status: 'skipped', reason: 'operator skipped' } };
        codexSummary = 'skipped (operator skipped)';
        host.terminal.writeOutput('Connect Codex skipped: operator skipped.\n');
      } else {
        const integrationResult = await applyCodexIntegration(host, plan);
        journal =
          integrationResult.status === 'verified'
            ? { ...journal, codex: { status: 'verified' } }
            : {
                ...journal,
                codex: {
                  status:
                    integrationResult.progress.skill === 'verified'
                      ? 'skill-installed'
                      : 'pending',
                },
                failure: { stage: 'codex', code: 'setup.codex-partial' },
              };
        codexSummary = integrationResult.status === 'verified' ? 'verified' : 'partial failure';
        host.terminal.writeOutput(
          `${integrationResult.summary}\n${integrationResult.recovery === undefined ? '' : `Recovery: ${integrationResult.recovery}\n`}`,
        );
      }
    }
    await saveSetupJournal(host, journal);
    host.terminal.writeOutput(
      'Setup complete.\n' +
        `Profile: ${answers.profileName} (default)\n` +
        `Service: Server Service (ready); PostgreSQL ownership: ${answers.managedPostgres ? `profile ${answers.profileName}` : 'external'}\n` +
        `Exposure: ${answers.exposure}; bind=${answers.hostname}:${answers.port}\n` +
        `Identity: ${started.runtime.deploymentOperator.displayName} (${started.runtime.deploymentOperator.id})\n` +
        'Doctor: PostgreSQL, port, HTTP health, and authenticated operator access verified\n' +
        `Codex integration: ${codexSummary}\n` +
        `Start: bunx prosto-datagram serve --profile ${JSON.stringify(answers.profileName)}\n` +
        `Check: bunx prosto-datagram doctor --profile ${JSON.stringify(answers.profileName)}\n` +
        (answers.managedPostgres
          ? `PostgreSQL lifecycle: bunx prosto-datagram postgres start|stop|status --profile ${JSON.stringify(answers.profileName)}\n` +
            `Backups: protect Docker volume ${answers.managedPostgres.volumeName}; Datagram never deletes it automatically.\n`
          : '') +
        'Optional next step: invite teammates after the Service is running.\n',
    );
  } catch {
    throw new DatagramError(
      'setup.server-verification-failed',
      `Server Service could not be started or verified. Check bind, TLS/proxy, then run \`datagram doctor --profile ${answers.profileName}\`.`,
      500,
    );
  } finally {
    if (started) {
      await started.server.stop();
      await started.runtime.close();
    }
  }
}
