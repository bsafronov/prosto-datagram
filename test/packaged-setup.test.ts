import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { managedPostgresDefinition, resolvePlatformDirectories } from '../src/packages/cli';
import { createNativeCredentialProvider } from '../src/packages/cli/credentials';
import { createRuntime } from '../src/packages/runtime';

const repository = join(import.meta.dir, '..');
const postgresUrl = process.env.DATAGRAM_TEST_POSTGRES_URL;
const resources: string[] = [];
const managedResources: { containerName: string; volumeName: string }[] = [];
let packageDirectory = '';
let tarball = '';
let installedPackage = '';

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

async function command(
  argv: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ProcessResult> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const dockerAvailable = (await command(['docker', 'version'])).exitCode === 0;

function packageCommand(...args: string[]): string[] {
  return [process.execPath, join(installedPackage, 'src', 'cli.ts'), ...args];
}

async function interactivePackageCommand(
  args: readonly string[],
  steps: readonly { readonly waitFor: string; readonly keys: string }[],
  home: string,
  environment: Record<string, string | undefined> = {},
): Promise<ProcessResult> {
  const argv = packageCommand(...args);
  const child = Bun.spawn(
    ['python3', join(repository, 'test', 'fixtures', 'pty-runner.py'), ...argv],
    {
      cwd: home,
      env: { ...isolatedEnvironment(home), ...environment },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  child.stdin.write(JSON.stringify(steps));
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 120_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { exitCode, stdout, stderr };
}

function isolatedEnvironment(home: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  };
}

function directories(home: string) {
  return resolvePlatformDirectories(platform(), home, isolatedEnvironment(home));
}

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  resources.push(home);
  await mkdir(home, { recursive: true });
  return home;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function nativeCredentialAvailable(home: string): Promise<boolean> {
  const provider = createNativeCredentialProvider(platform(), ({ command: executable, args }) =>
    command([executable, ...args], { cwd: home, env: isolatedEnvironment(home) }),
  );
  return provider === undefined ? false : (await provider.availability()).available;
}

async function assertAuthenticatedServe(
  home: string,
  profileName: string,
  port: number,
  token: string,
  environment: Record<string, string | undefined> = {},
): Promise<void> {
  const child = Bun.spawn(
    packageCommand('serve', '--profile', profileName, '--port', String(port)),
    {
      cwd: home,
      env: { ...isolatedEnvironment(home), ...environment },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let stderr = '';
  const stderrDone = (async () => {
    for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk);
  })();
  try {
    const deadline = Date.now() + 30_000;
    while (!stderr.includes('Datagram HTTP listening')) {
      if (Date.now() >= deadline) throw new Error(`Server did not start: ${stderr}`);
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(50).then(() => false)])) {
        throw new Error(`Server exited before verification: ${stderr}`);
      }
    }
    const endpoint = `http://127.0.0.1:${port}/v1/actions`;
    expect((await fetch(endpoint)).status).toBe(401);
    const authenticated = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ actions: expect.any(Array) });
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    await stderrDone;
  }
}

beforeAll(async () => {
  packageDirectory = await mkdtemp(join(tmpdir(), 'datagram-packaged-journey-'));
  resources.push(packageDirectory);
  const packed = await command(
    [process.execPath, 'pm', 'pack', '--destination', packageDirectory, '--quiet'],
    { cwd: repository },
  );
  expect(packed.exitCode).toBe(0);
  const packedPath = packed.stdout.trim().split('\n').at(-1) ?? '';
  tarball = isAbsolute(packedPath) ? packedPath : join(packageDirectory, packedPath);
  const unpacked = await command(['tar', '-xzf', tarball, '-C', packageDirectory]);
  expect(unpacked.exitCode).toBe(0);
  installedPackage = join(packageDirectory, 'package');
  const installed = await command([process.execPath, 'install', '--production'], {
    cwd: installedPackage,
  });
  expect(installed.exitCode).toBe(0);
});

afterAll(async () => {
  for (const resource of managedResources) {
    await command(['docker', 'rm', '--force', resource.containerName]).catch(() => undefined);
    await command(['docker', 'volume', 'rm', resource.volumeName]).catch(() => undefined);
  }
  await Promise.all(resources.map((path) => rm(path, { recursive: true, force: true })));
});

test('packed CLI completes Local setup through first real Table Record', async () => {
  const home = await temporaryHome('datagram-packaged-local-');
  const profileName = `local-${crypto.randomUUID().slice(0, 8)}`;
  const result = await interactivePackageCommand(
    ['init'],
    [
      { waitFor: 'Use on this machine', keys: '\r' },
      { waitFor: 'Name this Service profile', keys: `${profileName}\r` },
      { waitFor: 'Identify the Deployment Operator', keys: 'Package Operator\r' },
      { waitFor: 'Use bunx without global installation', keys: '\u001b[B\u001b[B\r' },
      { waitFor: 'Identify the Deployment Operator', keys: 'Package Operator\r' },
      { waitFor: 'Use bunx without global installation', keys: '\r' },
      { waitFor: 'Apply this plan?', keys: '\r' },
      { waitFor: 'Channel title', keys: 'Launch plan\r' },
      { waitFor: 'First item', keys: 'Ship it\r' },
      { waitFor: 'Connect Codex now?', keys: '\r' },
    ],
    home,
  );

  if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
  expect(result.stdout).toContain('Use on this machine (Recommended)');
  expect(result.stdout).toContain('Setup complete.');
  const paths = directories(home);
  const profile = JSON.parse(
    await readFile(join(paths.configuration, 'profiles', `${profileName}.json`), 'utf8'),
  ) as {
    service: { databasePath: string };
    identity: { personId: string };
    setup: { starter: { channelId: string; status: string } };
  };
  expect(profile.setup.starter.status).toBe('complete');
  const runtime = await createRuntime({ databasePath: profile.service.databasePath });
  try {
    expect(await runtime.store.listTableRecords(profile.setup.starter.channelId)).toEqual([
      expect.objectContaining({ values: { name: 'Ship it' } }),
    ]);
    expect(await runtime.store.listOperations(profile.setup.starter.channelId)).toEqual([
      expect.objectContaining({ action: 'channel.create', origin: 'cli' }),
      expect.objectContaining({ action: 'table.field.add', origin: 'cli' }),
      expect.objectContaining({ action: 'table.record.create', origin: 'cli' }),
    ]);
  } finally {
    await runtime.close();
  }
  const doctor = await command(packageCommand('doctor', '--profile', profileName), {
    cwd: home,
    env: isolatedEnvironment(home),
  });
  expect(doctor).toMatchObject({ exitCode: 0, stderr: '' });
  expect(doctor.stdout).toContain(`Service ready. profile="${profileName}" kind=local`);
}, 120_000);

test('packed setup masks credentials and cancels before creating a profile', async () => {
  const home = await temporaryHome('datagram-packaged-cancel-');
  const fileChoice = (await nativeCredentialAvailable(home)) ? 2 : 1;
  const secret = 'private-password-marker';
  const result = await interactivePackageCommand(
    ['init'],
    [
      { waitFor: 'Use on this machine', keys: '\u001b[B\r' },
      { waitFor: 'Team Service profile name', keys: 'cancelled\r' },
      { waitFor: 'Deployment Operator display name', keys: 'Test Operator\r' },
      { waitFor: 'Existing PostgreSQL URL (externally owned)', keys: '\r' },
      {
        waitFor: 'Permission-restricted secret file',
        keys: '\u001b[B'.repeat(fileChoice - 1) + '\r',
      },
      {
        waitFor: 'Existing PostgreSQL URL (or Back/Cancel)',
        keys: `postgres://operator:${secret}@localhost:5432/datagram?sslmode=disable\r`,
      },
      { waitFor: 'Private network', keys: '\u0003' },
    ],
    home,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Setup cancelled. No changes were made.');
  expect(result.stdout).not.toContain(secret);
  expect(
    await Bun.file(join(directories(home).configuration, 'profiles', 'cancelled.json')).exists(),
  ).toBe(false);
  expect(
    await Bun.file(join(directories(home).configuration, 'secrets', 'cancelled.json')).exists(),
  ).toBe(false);
}, 30_000);

test.skipIf(postgresUrl === undefined)(
  'packed CLI configures external PostgreSQL and serves authenticated HTTP',
  async () => {
    const home = await temporaryHome('datagram-packaged-external-');
    const profileName = `external-${crypto.randomUUID().slice(0, 8)}`;
    const serverPort = await freePort();
    const bearerToken = `external-token-${crypto.randomUUID()}`;
    const environment = {
      DATAGRAM_POSTGRES_URL: postgresUrl,
      DATAGRAM_OPERATOR_TOKEN: bearerToken,
    };
    const environmentChoice = (await nativeCredentialAvailable(home)) ? '3' : '2';
    const result = await interactivePackageCommand(
      ['init'],
      [
        { waitFor: 'Use on this machine', keys: '\u001b[B\r' },
        { waitFor: 'Team Service profile name', keys: `${profileName}\r` },
        { waitFor: 'Deployment Operator display name', keys: 'External Operator\r' },
        { waitFor: 'Existing PostgreSQL URL (externally owned)', keys: '\r' },
        {
          waitFor: 'Environment references (Advanced)',
          keys: '\u001b[B'.repeat(Number(environmentChoice) - 1) + '\r',
        },
        { waitFor: 'PostgreSQL URL environment variable', keys: '\r' },
        { waitFor: 'Operator bearer token environment variable', keys: '\r' },
        { waitFor: 'Private network', keys: '\r' },
        { waitFor: 'HTTP port', keys: `${serverPort}\r` },
        { waitFor: 'Apply this plan?', keys: '\r' },
        { waitFor: 'Connect Codex now?', keys: '\r' },
      ],
      home,
      environment,
    );

    if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
    expect(result.stdout).toContain('external PostgreSQL (no infrastructure lifecycle ownership)');
    expect(result.stdout).toContain('authenticated operator access verified');
    expect(result.stdout).not.toContain(postgresUrl!);
    expect(result.stdout).not.toContain(bearerToken);
    const profileText = await readFile(
      join(directories(home).configuration, 'profiles', `${profileName}.json`),
      'utf8',
    );
    expect(profileText).not.toContain(postgresUrl!);
    expect(profileText).not.toContain(bearerToken);
    const servePort = await freePort();
    await assertAuthenticatedServe(home, profileName, servePort, bearerToken, environment);
  },
  120_000,
);

test.skipIf(postgresUrl === undefined || !dockerAvailable)(
  'packed CLI provisions profile-owned PostgreSQL and serves authenticated HTTP',
  async () => {
    const home = await temporaryHome('datagram-packaged-managed-');
    const profileName = `managed-${crypto.randomUUID().slice(0, 8)}`;
    const definition = managedPostgresDefinition(profileName, await freePort());
    managedResources.push(definition);
    const serverPort = await freePort();
    const fileChoice = (await nativeCredentialAvailable(home)) ? '2' : '1';
    const result = await interactivePackageCommand(
      ['init'],
      [
        { waitFor: 'Use on this machine', keys: '\u001b[B\r' },
        { waitFor: 'Team Service profile name', keys: `${profileName}\r` },
        { waitFor: 'Deployment Operator display name', keys: 'Managed Operator\r' },
        { waitFor: 'Existing PostgreSQL URL (externally owned)', keys: '\u001b[B\r' },
        { waitFor: 'PostgreSQL host port', keys: `${definition.port}\r` },
        {
          waitFor: 'Permission-restricted secret file',
          keys: '\u001b[B'.repeat(Number(fileChoice) - 1) + '\r',
        },
        { waitFor: 'Private network', keys: '\r' },
        { waitFor: 'HTTP port', keys: `${serverPort}\r` },
        { waitFor: 'Apply this plan?', keys: '\r' },
        { waitFor: 'Connect Codex now?', keys: '\r' },
      ],
      home,
    );

    if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
    expect(result.stdout).toContain('Docker-managed PostgreSQL owned by this profile');
    expect(result.stdout).toContain(`persistent Docker volume ${definition.volumeName}`);
    expect(result.stdout).toContain('authenticated operator access verified');
    const configuration = directories(home).configuration;
    const profile = JSON.parse(
      await readFile(join(configuration, 'profiles', `${profileName}.json`), 'utf8'),
    ) as {
      service: { infrastructure: { containerName: string; volumeName: string } };
      identity: { bearerCredential: { path: string; key: string } };
    };
    expect(profile.service.infrastructure).toMatchObject({
      containerName: definition.containerName,
      volumeName: definition.volumeName,
    });
    const secrets = JSON.parse(
      await readFile(profile.identity.bearerCredential.path, 'utf8'),
    ) as Record<string, string>;
    const servePort = await freePort();
    await assertAuthenticatedServe(
      home,
      profileName,
      servePort,
      secrets[profile.identity.bearerCredential.key]!,
    );
    const status = await command(packageCommand('postgres', 'status', '--profile', profileName), {
      cwd: home,
      env: isolatedEnvironment(home),
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`Managed PostgreSQL: running; profile="${profileName}"`);
  },
  180_000,
);
