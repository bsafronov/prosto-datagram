import { afterEach, expect, test } from 'bun:test';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cliUsage,
  resolvePlatformDirectories,
  runCli,
  type CredentialProvider,
  type CliHost,
} from '../src/packages/cli';
import { createRuntime, openRuntime, type DatagramRuntime } from '../src/packages/runtime';

const temporaryDirectories: string[] = [];
let runtime: DatagramRuntime | undefined;

async function cli(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: join(import.meta.dir, '..'),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function scriptedInput(values: readonly string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield `${value}\n`;
    },
  };
}

function localSetupHost(
  configuration: string,
  data: string,
  answers: readonly string[],
  output: string[],
  runExternalCommand: CliHost['runExternalCommand'] = () =>
    Promise.reject(new Error('unexpected external command')),
  failAction?: string,
  legacy?: {
    readonly currentDirectory?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): CliHost {
  return {
    terminal: {
      input: scriptedInput(answers),
      inputIsInteractive: true,
      outputIsInteractive: true,
      writeOutput: (value) => output.push(value),
      writeError: () => undefined,
    },
    environment: { get: (name) => legacy?.environment?.[name] },
    filesystem: {
      pathExists,
      readTextFile: (path) => readFile(path, 'utf8'),
      writeTextFile: (path, value, options) => writeFile(path, value, options),
      writeTextFileAtomic: async (path, value, options) => {
        const temporaryPath = `${path}.tmp`;
        await writeFile(temporaryPath, value, options);
        await rename(temporaryPath, path);
      },
      makeDirectory: (path, options) => mkdir(path, options).then(() => undefined),
    },
    directories: { configuration, data },
    currentDirectory: legacy?.currentDirectory ?? '/unrelated/current-directory',
    runExternalCommand,
    createRuntime: async (options) => {
      const created = await createRuntime(options);
      if (failAction === undefined) return created;
      return {
        ...created,
        app: new Proxy(created.app, {
          get(target, property) {
            if (property === 'executeAction') {
              return async (...args: Parameters<typeof target.executeAction>) => {
                if (args[2] === failAction) throw new Error('injected starter failure');
                return target.executeAction(...args);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };
    },
    openRuntime,
    startHttpServer: () => Promise.reject(new Error('unexpected HTTP server')),
    onTermination: () => undefined,
    exit: () => undefined,
    setExitCode: () => undefined,
  };
}

async function writeProfile(
  configuration: string,
  name: string,
  databasePath: string,
  personId: string,
  displayName: string,
): Promise<void> {
  const profileDirectory = join(configuration, 'profiles');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    join(profileDirectory, `${name}.json`),
    `${JSON.stringify({
      version: 1,
      name,
      service: { kind: 'local', databasePath },
      identity: { personId, displayName },
    })}\n`,
  );
}

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

test('CLI execution uses injected host services without touching process configuration', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const runtimeOptions: unknown[] = [];
  const serverOptions: unknown[] = [];
  const exitCodes: number[] = [];
  let terminationHandler: (() => void | Promise<void>) | undefined;
  let serverStopped = false;
  const injectedRuntime = await createRuntime({ databasePath: ':memory:' });
  const serverRuntime = await createRuntime({ databasePath: ':memory:' });
  const host: CliHost = {
    terminal: {
      input: {
        async *[Symbol.asyncIterator]() {
          yield 'scripted input';
        },
      },
      inputIsInteractive: true,
      outputIsInteractive: true,
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    },
    environment: {
      get: (name) => (name === 'DATAGRAM_DB' ? '/injected/data/datagram.sqlite' : undefined),
    },
    filesystem: {
      pathExists: () => Promise.resolve(false),
      readTextFile: () => Promise.reject(new Error('unexpected filesystem read')),
      writeTextFile: () => Promise.reject(new Error('unexpected filesystem write')),
      writeTextFileAtomic: () => Promise.reject(new Error('unexpected filesystem write')),
      makeDirectory: () => Promise.reject(new Error('unexpected directory creation')),
    },
    directories: {
      configuration: '/injected/config',
      data: '/injected/data',
    },
    currentDirectory: '/injected/current',
    runExternalCommand: () => Promise.reject(new Error('unexpected external command')),
    createRuntime: (options) => {
      runtimeOptions.push(options);
      return Promise.resolve(injectedRuntime);
    },
    openRuntime,
    startHttpServer: (options) => {
      serverOptions.push(options);
      return Promise.resolve({
        identityMode: 'development',
        runtime: serverRuntime,
        server: {
          url: new URL('http://127.0.0.1:4310/'),
          stop: () => {
            serverStopped = true;
          },
        },
      });
    },
    onTermination: (handler) => {
      terminationHandler = handler;
    },
    exit: (code) => exitCodes.push(code),
    setExitCode: () => undefined,
  };

  await runCli(['--help'], host);
  await runCli(['actions'], host);
  await runCli(['serve', '--port', '4310', '--db', '/injected/server.sqlite'], host);
  await terminationHandler?.();

  expect(output[0]).toBe(cliUsage);
  expect(JSON.parse(output[1] ?? '')).toEqual(injectedRuntime.app.actions.catalog());
  expect(runtimeOptions).toEqual([{ databasePath: '/injected/data/datagram.sqlite' }]);
  expect(serverOptions).toEqual([{ databasePath: '/injected/server.sqlite', port: 4310 }]);
  expect(errors).toEqual([
    'Datagram HTTP listening on http://127.0.0.1:4310/ (development identity mode)\n',
  ]);
  expect(serverStopped).toBe(true);
  expect(exitCodes).toEqual([0]);
});

test('guided init creates and verifies a named default Local Service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-init-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const output: string[] = [];
  const host = localSetupHost(
    configuration,
    data,
    ['', 'discarded', 'Back', 'personal', 'Ada Lovelace', '', '', 'Launch plan', 'Ship it'],
    output,
  );

  await runCli(['init'], host);

  const databasePath = join(data, 'profiles', 'personal', 'datagram.sqlite');
  const profilePath = join(configuration, 'profiles', 'personal.json');
  const journalPath = join(configuration, 'setup-journals', 'personal.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as {
    version: number;
    name: string;
    service: { kind: string; databasePath: string };
    identity: { displayName: string; personId: string };
    setup: {
      core: string;
      starter: {
        status: string;
        channelId: string;
        channelOperationId: string;
        fieldOperationId: string;
        recordOperationId: string;
      };
    };
  };
  const starter = structuredClone(profile.setup.starter);
  expect(profile).toMatchObject({
    version: 1,
    name: 'personal',
    service: { kind: 'local', databasePath },
    identity: {
      displayName: 'Ada Lovelace',
      personId: expect.stringMatching(/^person_/),
    },
    setup: {
      core: 'verified',
      starter: {
        status: 'complete',
        channelId: expect.stringMatching(/^channel_/),
        channelOperationId: expect.stringMatching(/^operation_/),
        fieldOperationId: expect.stringMatching(/^operation_/),
        recordOperationId: expect.stringMatching(/^operation_/),
      },
    },
  });
  expect(await readFile(join(configuration, 'default-profile'), 'utf8')).toBe('personal\n');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
  expect(journal).toMatchObject({
    version: 1,
    profileName: 'personal',
    core: 'verified',
    starter: {
      status: 'complete',
      channelId: starter.channelId,
      channelOperationId: starter.channelOperationId,
      fieldOperationId: starter.fieldOperationId,
      recordOperationId: starter.recordOperationId,
    },
    durableInstall: 'skipped',
  });
  expect(JSON.stringify(journal)).not.toContain('Ada Lovelace');
  expect(JSON.stringify(journal)).not.toContain('Launch plan');
  expect(JSON.stringify(journal)).not.toContain('Ship it');
  expect(await pathExists(databasePath)).toBe(true);

  runtime = await createRuntime({ databasePath });
  expect(runtime.owner).toMatchObject({
    displayName: 'Ada Lovelace',
    id: profile.identity.personId,
    isOperator: true,
  });
  expect(await runtime.store.listTableFields(starter.channelId)).toEqual([
    expect.objectContaining({
      key: 'name',
      label: 'Name',
      required: true,
      type: 'text',
      unique: true,
    }),
  ]);
  expect(await runtime.store.listTableRecords(starter.channelId)).toEqual([
    expect.objectContaining({ values: { name: 'Ship it' } }),
  ]);
  expect(await runtime.store.listOperations(starter.channelId)).toEqual([
    expect.objectContaining({ action: 'channel.create', origin: 'cli' }),
    expect.objectContaining({ action: 'table.field.add', origin: 'cli' }),
    expect.objectContaining({ action: 'table.record.create', origin: 'cli' }),
  ]);
  const rendered = output.join('');
  expect(rendered).toContain('Use on this machine (Recommended)');
  expect(rendered).toContain('Type Back');
  expect(rendered).toContain('[1/3] Creating Local Service');
  expect(rendered).toContain('[3/3] Verifying profile, Store, runtime, and identity');
  expect(rendered).toContain(`Configuration: ${profilePath}`);
  expect(rendered).toContain(`SQLite data: ${databasePath}`);
  expect(rendered).toContain('CLI: bunx prosto-datagram actions --profile "personal"');
  expect(rendered).toContain('Durable commands: skipped');
  expect(rendered).toContain('bunx --package prosto-datagram datagram-mcp');
  expect(rendered).toContain(`First Channel: ${starter.channelId}`);
});

test('guided team init stores references and verifies an external PostgreSQL Server Service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-server-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const output: string[] = [];
  const secretMarker = 'postgres-password-marker';
  const connectionString =
    `postgres://operator:${secretMarker}@localhost:5432/datagram?sslmode=disable`;
  const base = localSetupHost(
    configuration,
    join(directory, 'data'),
    ['2', 'team', 'Ada Operator', '', '', connectionString, '', '', 'yes'],
    output,
  );
  let stopped = false;
  let closed = false;
  const host: CliHost = {
    ...base,
    probePostgres: () => Promise.resolve(),
    checkPort: () => Promise.resolve(),
    startServerService: (() =>
      Promise.resolve({
        runtime: {
          deploymentOperator: {
            id: 'person_team_operator',
            displayName: 'Ada Operator',
            isOperator: true,
            createdAt: '2026-09-02T00:00:00.000Z',
          },
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        },
        server: {
          url: new URL('http://127.0.0.1:3100/'),
          stop: () => {
            stopped = true;
          },
        },
      })) as unknown as NonNullable<CliHost['startServerService']>,
    request: (request) => {
      const authenticated = request.url.endsWith('/v1/actions');
      if (authenticated) expect(request.headers.get('authorization')).toMatch(/^Bearer /);
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };

  await runCli(['init'], host);

  const profilePath = join(configuration, 'profiles', 'team.json');
  const secretPath = join(configuration, 'secrets', 'team.json');
  const profileText = await readFile(profilePath, 'utf8');
  expect(JSON.parse(profileText)).toMatchObject({
    service: {
      kind: 'server',
      infrastructure: { kind: 'external-postgres' },
      postgres: { credential: { kind: 'file', path: secretPath, key: 'postgresUrl' } },
      bind: { exposure: 'host', hostname: '127.0.0.1', port: 3100 },
    },
    identity: {
      personId: 'person_team_operator',
      bearerCredential: { kind: 'file', path: secretPath, key: 'bearerToken' },
    },
    setup: { core: 'verified' },
  });
  expect(profileText).not.toContain(secretMarker);
  expect(output.join('')).not.toContain(secretMarker);
  expect(output.join('')).toContain('no infrastructure lifecycle ownership');
  expect(output.join('')).toContain('Optional next step: invite teammates');
  expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(secretPath, 'utf8')).toContain(secretMarker);
  expect(stopped).toBe(true);
  expect(closed).toBe(true);

  const rerunOutput: string[] = [];
  await runCli(['init'], {
    ...host,
    terminal: {
      ...host.terminal,
      input: scriptedInput(['1']),
      writeOutput: (value) => rerunOutput.push(value),
    },
  });
  expect(rerunOutput.join('')).toContain('Existing setup detected for profile "team".');
  expect(rerunOutput.join('')).toContain('No changes made.');
  expect(runCli(['postgres', 'status', '--profile', 'team'], host)).rejects.toMatchObject({
    code: 'postgres.not-managed',
    message: expect.stringContaining('External PostgreSQL lifecycle is unchanged'),
  });
});

test('guided team wizard supports Back across team choices before Apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-server-back-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const output: string[] = [];
  await runCli(
    ['init'],
    localSetupHost(
      configuration,
      join(directory, 'data'),
      ['2', 'team', 'Back', 'revised', 'Operator', 'Back', 'final', 'Operator', '', 'Cancel'],
      output,
    ),
  );

  const rendered = output.join('');
  expect(rendered.match(/Team Service profile name/g)?.length).toBe(3);
  expect(rendered).toContain('Back. Back');
  expect(rendered).toContain('Setup cancelled. No changes were made.');
  expect(await pathExists(configuration)).toBe(false);
});

test('guided team init provisions persistent profile-owned PostgreSQL and exposes safe lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-managed-postgres-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const output: string[] = [];
  const base = localSetupHost(
    configuration,
    join(directory, 'data'),
    ['2', 'team', 'Ada Operator', '2', '', '', '', '', '55432', 'yes'],
    output,
  );
  let state: 'missing' | 'stopped' | 'running' = 'missing';
  let ensureCount = 0;
  const checkedPorts: number[] = [];
  const host: CliHost = {
    ...base,
    dockerPostgres: {
      available: () => Promise.resolve(true),
      ensure: () => {
        ensureCount += 1;
        state = 'running';
        return Promise.resolve();
      },
      start: () => {
        state = 'running';
        return Promise.resolve();
      },
      stop: () => {
        state = 'stopped';
        return Promise.resolve();
      },
      status: () => Promise.resolve(state),
    },
    probePostgres: () => Promise.resolve(),
    checkPort: (_hostname, port) => {
      checkedPorts.push(port);
      if (port === 5432) return Promise.reject(new Error('occupied'));
      return Promise.resolve();
    },
    startServerService: (() =>
      Promise.resolve({
        runtime: {
          deploymentOperator: {
            id: 'person_managed_operator',
            displayName: 'Ada Operator',
            isOperator: true,
            createdAt: '2026-09-02T00:00:00.000Z',
          },
          close: () => Promise.resolve(),
        },
        server: { url: new URL('http://127.0.0.1:3100/'), stop: () => undefined },
      })) as unknown as NonNullable<CliHost['startServerService']>,
    request: (request) => {
      if (request.url.endsWith('/v1/actions')) {
        expect(request.headers.get('authorization')).toMatch(/^Bearer /);
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };

  await runCli(['init'], host);

  const profilePath = join(configuration, 'profiles', 'team.json');
  const profileText = await readFile(profilePath, 'utf8');
  expect(JSON.parse(profileText)).toMatchObject({
    service: {
      infrastructure: {
        kind: 'docker-postgres',
        image: expect.stringContaining('postgres:17-alpine@sha256:'),
        containerName: 'prosto-datagram-postgres-team',
        volumeName: 'prosto-datagram-postgres-team-data',
        port: 55432,
      },
    },
    setup: { core: 'verified' },
  });
  const rendered = output.join('');
  expect(rendered).toContain('Docker-managed PostgreSQL owned by this profile');
  expect(rendered).toContain('Image download: postgres:17-alpine@sha256:');
  expect(rendered).toContain('persistent Docker volume prosto-datagram-postgres-team-data');
  expect(rendered).toContain('never remove database data');
  expect(rendered).not.toMatch(/postgres:\/\/datagram:[^[]/);
  expect(ensureCount).toBe(1);
  expect(checkedPorts).toEqual([5432, 55432, 3100]);
  expect(rendered).toContain('PostgreSQL port 5432 is unavailable. Choose another port before Apply');

  await runCli(['postgres', 'stop', '--profile', 'team'], host);
  expect(String(state)).toBe('stopped');
  await runCli(['postgres', 'start', '--profile', 'team'], host);
  expect(String(state)).toBe('running');
  await runCli(['postgres', 'status', '--profile', 'team'], host);
  expect(output.join('')).toContain('Managed PostgreSQL: running; profile="team"');
});

test('managed PostgreSQL setup explains missing Docker before Apply without installing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-no-docker-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const externalCommands: unknown[] = [];
  const base = localSetupHost(
    configuration,
    join(directory, 'data'),
    ['2', 'team', 'Operator', '2', '', '', '', ''],
    [],
    (request) => {
      externalCommands.push(request);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
  );
  const host: CliHost = {
    ...base,
    dockerPostgres: {
      available: () => Promise.resolve(false),
      ensure: () => Promise.reject(new Error('must not apply')),
      start: () => Promise.reject(new Error('must not start')),
      stop: () => Promise.reject(new Error('must not stop')),
      status: () => Promise.reject(new Error('must not inspect')),
    },
  };

  expect(runCli(['init'], host)).rejects.toMatchObject({
    code: 'setup.docker-unavailable',
    message: expect.stringContaining('choose an existing PostgreSQL URL'),
  });
  expect(externalCommands).toEqual([]);
  expect(await pathExists(join(configuration, 'profiles', 'team.json'))).toBe(false);
});

test('stopped managed PostgreSQL checks its host port before Apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-stopped-postgres-port-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const secretDirectory = join(configuration, 'secrets');
  await mkdir(secretDirectory, { recursive: true });
  await writeFile(
    join(secretDirectory, 'team.json'),
    `${JSON.stringify({
      postgresUrl: 'postgres://datagram:password@127.0.0.1:5432/datagram?sslmode=disable',
      bearerToken: 'operator-token',
    })}\n`,
  );
  let ensureCount = 0;
  const host: CliHost = {
    ...localSetupHost(
      configuration,
      join(directory, 'data'),
      ['2', 'team', 'Operator', '2', '', '', '', ''],
      [],
    ),
    dockerPostgres: {
      available: () => Promise.resolve(true),
      ensure: () => {
        ensureCount += 1;
        return Promise.resolve();
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      status: () => Promise.resolve('stopped'),
    },
    checkPort: (_hostname, port) =>
      port === 5432 ? Promise.reject(new Error('occupied')) : Promise.resolve(),
  };

  expect(runCli(['init'], host)).rejects.toMatchObject({
    code: 'setup.postgres-port-unavailable',
    message: expect.stringContaining('before Apply'),
  });
  expect(ensureCount).toBe(0);
  expect(await pathExists(join(configuration, 'profiles', 'team.json'))).toBe(false);
});

test('guided team init prefers native storage and persists only opaque provider references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-native-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const output: string[] = [];
  const postgresSecret = ['postgres', 'native', 'marker'].join('-');
  const connectionString = `postgres://operator:${postgresSecret}@localhost:5432/datagram?sslmode=disable`;
  const storedSecrets: string[] = [];
  const storedAccounts: string[] = [];
  const provider: CredentialProvider = {
    kind: 'macos-keychain',
    availability: () => Promise.resolve({ available: true }),
    create: ({ account, secret }) => {
      storedAccounts.push(account);
      storedSecrets.push(secret);
      return Promise.resolve({
        kind: 'native',
        provider: 'macos-keychain',
        service: 'prosto-datagram',
        account,
      });
    },
    resolve: () => Promise.reject(new Error('unexpected resolve')),
    update: () => Promise.reject(new Error('unexpected update')),
  };
  const base = localSetupHost(
    configuration,
    join(directory, 'data'),
    ['2', 'team', 'Ada Operator', '', '', connectionString, '', '', 'yes'],
    output,
  );
  const host: CliHost = {
    ...base,
    credentialProvider: provider,
    probePostgres: () => Promise.resolve(),
    checkPort: () => Promise.resolve(),
    startServerService: (() =>
      Promise.resolve({
        runtime: {
          deploymentOperator: {
            id: 'person_native_operator',
            displayName: 'Ada Operator',
            isOperator: true,
            createdAt: '2026-09-02T00:00:00.000Z',
          },
          close: () => Promise.resolve(),
        },
        server: { url: new URL('http://127.0.0.1:3100/'), stop: () => undefined },
      })) as unknown as NonNullable<CliHost['startServerService']>,
    request: () => Promise.resolve(new Response('{}', { status: 200 })),
  };

  await runCli(['init'], host);

  const profileText = await readFile(join(configuration, 'profiles', 'team.json'), 'utf8');
  const profile = JSON.parse(profileText) as Record<string, unknown>;
  expect(profile).toMatchObject({
    service: {
      postgres: {
        credential: {
          kind: 'native',
          provider: 'macos-keychain',
          service: 'prosto-datagram',
        },
      },
    },
    identity: {
      bearerCredential: {
        kind: 'native',
        provider: 'macos-keychain',
        service: 'prosto-datagram',
      },
    },
  });
  expect(storedSecrets).toHaveLength(2);
  expect(storedSecrets).toContain(connectionString);
  expect(storedAccounts[0]).toMatch(/^team:[0-9a-f-]+:postgres$/);
  expect(storedAccounts[1]).toBe(storedAccounts[0]?.replace(/:postgres$/, ':operator'));
  expect(profileText).not.toContain(postgresSecret);
  expect(profileText).not.toContain(storedSecrets[1] ?? 'missing bearer secret');
  expect(output.join('')).not.toContain(postgresSecret);
  expect(output.join('')).not.toContain(storedSecrets[1] ?? 'missing bearer secret');
  expect(output.join('')).toContain('System credential store (macos-keychain) (Recommended)');
  expect(await pathExists(join(configuration, 'secrets', 'team.json'))).toBe(false);
});

test('guided team init requires an explicit fallback when native storage is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-fallback-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const output: string[] = [];
  const host: CliHost = {
    ...localSetupHost(
      configuration,
      join(directory, 'data'),
      ['2', 'team', 'Operator', '', 'cancel'],
      output,
    ),
    credentialProvider: {
      kind: 'linux-secret-service',
      availability: () => Promise.resolve({ available: false, reason: 'No unlocked user collection.' }),
      create: () => Promise.reject(new Error('unexpected create')),
      resolve: () => Promise.reject(new Error('unexpected resolve')),
      update: () => Promise.reject(new Error('unexpected update')),
    },
  };

  await runCli(['init'], host);

  expect(output.join('')).toContain('System credential store unavailable: No unlocked user collection.');
  expect(output.join('')).toContain('Choose an explicit fallback');
  expect(await pathExists(join(configuration, 'profiles', 'team.json'))).toBe(false);
});

test('guided team init reports PostgreSQL preflight failures without leaking the URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-server-failure-'));
  temporaryDirectories.push(directory);
  const marker = 'must-not-leak';
  const host: CliHost = {
    ...localSetupHost(
      join(directory, 'configuration'),
      join(directory, 'data'),
      ['2', 'team', 'Operator', '', '', `postgres://u:${marker}@localhost/db?sslmode=disable`, '', ''],
      [],
    ),
    probePostgres: () => Promise.reject(new Error(`password=${marker}`)),
    checkPort: () => Promise.resolve(),
  };

  try {
    await runCli(['init'], host);
    throw new Error('expected preflight failure');
  } catch (error) {
    expect(error).toMatchObject({ code: 'setup.postgres-unreachable' });
    expect(String((error as Error).message)).not.toContain(marker);
  }
});

test('guided team init blocks public plaintext exposure before Apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-public-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const host = localSetupHost(
    configuration,
    join(directory, 'data'),
    [
      '2',
      'team',
      'Operator',
      '',
      '',
      'postgres://u:p@localhost/datagram?sslmode=disable',
      '3',
      '0.0.0.0',
      '',
    ],
    [],
  );

  expect(runCli(['init'], host)).rejects.toMatchObject({ code: 'setup.public-tls-required' });
  expect(await pathExists(join(configuration, 'profiles', 'team.json'))).toBe(false);
  expect(await pathExists(join(configuration, 'secrets', 'team.json'))).toBe(false);
});

test('guided init adopts current-directory SQLite by reference and keeps identity and data intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-adopt-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const databasePath = join(directory, 'datagram.sqlite');
  let legacyRuntime = await createRuntime({
    databasePath,
    ownerDisplayName: 'Existing Operator',
  });
  const existingIdentity = legacyRuntime.owner;
  const receipt = await legacyRuntime.app.executeAction(
    existingIdentity.id,
    'cli',
    'channel.create',
    { title: 'Existing private work', typeId: 'table' },
  );
  const existingChannelId = receipt.subject?.id ?? '';
  await legacyRuntime.close();
  const databaseBefore = await readFile(databasePath);

  const output: string[] = [];
  await runCli(
    ['init'],
    localSetupHost(configuration, data, ['', 'adopted', ''], output, undefined, undefined, {
      currentDirectory: directory,
    }),
  );

  const profilePath = join(configuration, 'profiles', 'adopted.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as {
    service: { databasePath: string };
    identity: { displayName: string; personId: string };
  };
  expect(profile).toMatchObject({
    service: { databasePath },
    identity: {
      displayName: existingIdentity.displayName,
      personId: existingIdentity.id,
    },
  });
  expect(await readFile(join(configuration, 'default-profile'), 'utf8')).toBe('adopted\n');
  expect(
    JSON.parse(await readFile(join(configuration, 'setup-journals', 'adopted.json'), 'utf8')),
  ).toMatchObject({
    profileName: 'adopted',
    core: 'verified',
    starter: { status: 'pending' },
    durableInstall: 'skipped',
  });
  expect(await readFile(databasePath)).toEqual(databaseBefore);

  legacyRuntime = await createRuntime({ databasePath });
  expect(legacyRuntime.owner.id).toBe(existingIdentity.id);
  expect(await legacyRuntime.store.getChannel(existingChannelId)).toMatchObject({
    id: existingChannelId,
    title: 'Existing private work',
  });
  await legacyRuntime.close();

  const doctorOutput: string[] = [];
  await runCli(
    ['doctor', '--profile', 'adopted'],
    localSetupHost(configuration, data, [], doctorOutput),
  );
  expect(doctorOutput.join('')).toContain('Service ready. profile="adopted" kind=local');

  const rerunOutput: string[] = [];
  await runCli(
    ['init', '--profile', 'adopted'],
    localSetupHost(configuration, data, ['1'], rerunOutput),
  );
  expect(rerunOutput.join('')).toContain('Existing setup detected');
  expect(rerunOutput.join('')).toContain('journal: valid');
  expect(await readdir(join(configuration, 'profiles'))).toEqual(['adopted.json']);
  expect(output.join('')).not.toContain('Existing private work');
  expect(output.join('')).toContain('referenced in place; not moved, rewritten, or deleted');
});

test('guided init previews legacy environment values and cancellation creates no profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-adopt-cancel-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const relativeDatabasePath = join('legacy', 'existing.sqlite');
  const databasePath = join(directory, relativeDatabasePath);
  await mkdir(join(directory, 'legacy'), { recursive: true });
  const legacyRuntime = await createRuntime({
    databasePath,
    ownerDisplayName: 'Environment Operator',
  });
  const actorId = legacyRuntime.owner.id;
  await legacyRuntime.close();
  const databaseBefore = await readFile(databasePath);
  const output: string[] = [];

  await runCli(
    ['init'],
    localSetupHost(configuration, data, ['', '', 'Cancel'], output, undefined, undefined, {
      currentDirectory: directory,
      environment: {
        DATAGRAM_ACTOR_ID: actorId,
        DATAGRAM_DB: relativeDatabasePath,
      },
    }),
  );

  const rendered = output.join('');
  expect(rendered).toContain('legacy environment configuration');
  expect(rendered).toContain(`DATAGRAM_DB: ${relativeDatabasePath}`);
  expect(rendered).toContain(`DATAGRAM_ACTOR_ID: ${actorId}`);
  expect(rendered).toContain(`SQLite data reference: ${databasePath}`);
  expect(rendered).toContain('Adoption cancelled. No changes were made.');
  expect(await pathExists(join(configuration, 'profiles', 'local.json'))).toBe(false);
  expect(await pathExists(join(configuration, 'default-profile'))).toBe(false);
  expect(await readFile(databasePath)).toEqual(databaseBefore);
});

test('guided init previews and runs durable installation only after consent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-global-install-'));
  temporaryDirectories.push(directory);
  const output: string[] = [];
  const requests: Parameters<CliHost['runExternalCommand']>[0][] = [];
  const globalBin = join(directory, 'bun-bin');
  const host = localSetupHost(
    join(directory, 'configuration'),
    join(directory, 'data'),
    ['', 'personal', 'Ada Lovelace', 'yes', 'yes', 'Launch plan', 'Ship it'],
    output,
    (request) => {
      requests.push(request);
      if (request.args?.[0] === 'pm') {
        return Promise.resolve({ exitCode: 0, stdout: `${globalBin}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
  );

  await runCli(['init'], host);

  expect(requests).toEqual([
    { command: 'bun', args: ['pm', 'bin', '-g'] },
    { command: 'bun', args: ['install', '--global', 'prosto-datagram'] },
  ]);
  const rendered = output.join('');
  expect(rendered).toContain('Durable install command: bun install --global prosto-datagram');
  expect(rendered).toContain(join(globalBin, 'datagram'));
  expect(rendered).toContain(join(globalBin, 'datagram-mcp'));
  expect(rendered).toContain('Durable commands: installed');
});

test('optional installer failure preserves core setup and gives exact resume command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-install-failure-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const output: string[] = [];
  let calls = 0;
  const host = localSetupHost(
    configuration,
    data,
    ['', 'personal', 'Grace Hopper', 'yes', 'yes', 'Launch plan', 'Ship it'],
    output,
    () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? { exitCode: 0, stdout: `${join(directory, 'bun-bin')}\n`, stderr: '' }
          : { exitCode: 23, stdout: '', stderr: 'sensitive installer details' },
      );
    },
  );

  await runCli(['init'], host);

  expect(await pathExists(join(data, 'profiles', 'personal', 'datagram.sqlite'))).toBe(true);
  expect(await pathExists(join(configuration, 'profiles', 'personal.json'))).toBe(true);
  const rendered = output.join('');
  expect(rendered).toContain('Core Service remains ready.');
  expect(rendered).toContain('Resume optional installation: bun install --global prosto-datagram');
  expect(rendered).toContain('Durable commands: pending (installer exit code 23)');
  expect(rendered).not.toContain('sensitive installer details');
  const journalPath = join(configuration, 'setup-journals', 'personal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    core: string;
    durableInstall: string;
    failure: { stage: string; code: string };
  };
  expect(journal).toMatchObject({
    core: 'verified',
    durableInstall: 'pending',
    failure: { stage: 'durable-install', code: 'setup.durable-install-failed' },
  });
  expect(JSON.stringify(journal)).not.toContain('sensitive installer details');

  const resumedOutput: string[] = [];
  const resumedRequests: Parameters<CliHost['runExternalCommand']>[0][] = [];
  await runCli(
    ['init', '--profile', 'personal'],
    localSetupHost(configuration, data, ['', '', 'yes'], resumedOutput, (request) => {
      resumedRequests.push(request);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }),
  );
  expect(resumedRequests).toEqual([
    { command: 'bun', args: ['install', '--global', 'prosto-datagram'] },
  ]);
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
    core: 'verified',
    durableInstall: 'verified',
  });
  expect(resumedOutput.join('')).toContain('Core will not be repeated.');
});

test('ordinary commands target the default or explicitly selected Service profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-profiles-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const personalDatabase = join(directory, 'personal.sqlite');
  const workDatabase = join(directory, 'work.sqlite');
  const personalRuntime = await createRuntime({
    databasePath: personalDatabase,
    ownerDisplayName: 'Personal Operator',
  });
  const workRuntime = await createRuntime({
    databasePath: workDatabase,
    ownerDisplayName: 'Work Operator',
  });
  await writeProfile(
    configuration,
    'personal',
    personalDatabase,
    personalRuntime.owner.id,
    personalRuntime.owner.displayName,
  );
  await writeProfile(
    configuration,
    'work',
    workDatabase,
    workRuntime.owner.id,
    workRuntime.owner.displayName,
  );
  await writeFile(join(configuration, 'default-profile'), 'personal\n');
  await personalRuntime.close();
  await workRuntime.close();

  const output: string[] = [];
  const host = localSetupHost(configuration, join(directory, 'data'), [], output);
  await runCli(
    [
      'action',
      'channel.create',
      '--input',
      JSON.stringify({ title: 'Work Table', typeId: 'table' }),
      '--profile',
      'work',
    ],
    host,
  );
  const created = JSON.parse(output.pop() ?? '') as { subject: { id: string } };

  await runCli(['query', 'channel.list'], host);
  const defaultResult = JSON.parse(output.pop() ?? '') as { data: { id: string }[] };
  expect(defaultResult.data).toEqual([]);

  await runCli(['query', 'channel.list', '--profile', 'work'], host);
  const workResult = JSON.parse(output.pop() ?? '') as { data: { id: string }[] };
  expect(workResult.data.map(({ id }) => id)).toContain(created.subject.id);

  await runCli(['agent-query', 'channel.list', '--profile', 'work'], host);
  expect(JSON.parse(output.pop() ?? '')).toMatchObject({
    id: expect.any(String),
    purpose: 'channel.list',
  });
});

test('ordinary action, query, and agent-query commands support Server Service profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-server-profile-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const profiles = join(configuration, 'profiles');
  const secretPath = join(configuration, 'server-secrets.json');
  await mkdir(profiles, { recursive: true });
  await writeFile(secretPath, `${JSON.stringify({ postgresUrl: 'unused', bearerToken: 'token' })}\n`);
  await writeFile(
    join(profiles, 'team.json'),
    `${JSON.stringify({
      version: 1,
      name: 'team',
      service: {
        kind: 'server',
        infrastructure: { kind: 'external-postgres' },
        serviceKey: 'service_team',
        postgres: { credential: { kind: 'file', path: secretPath, key: 'postgresUrl' } },
        bind: { exposure: 'host', hostname: '127.0.0.1', port: 4310 },
      },
      identity: {
        personId: 'person_team',
        displayName: 'Team Operator',
        bearerCredential: { kind: 'file', path: secretPath, key: 'bearerToken' },
      },
    })}\n`,
  );
  await writeFile(join(configuration, 'default-profile'), 'team\n');
  const output: string[] = [];
  const requested: string[] = [];
  const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  const host: CliHost = {
    ...localSetupHost(configuration, join(directory, 'data'), [], output),
    request: async (request) => {
      const url = new URL(request.url);
      requested.push(`${request.method} ${url.pathname}`);
      expect(request.headers.get('authorization')).toBe('Bearer token');
      if (request.method === 'GET' && url.pathname === '/v1/actions') {
        return Response.json({ actions: [{ name: 'channel.create', description: 'Create', inputSchema }] });
      }
      if (request.method === 'GET' && url.pathname === '/v1/queries') {
        return Response.json({ queries: [{ name: 'channel.list', description: 'List', inputSchema }] });
      }
      if (url.pathname === '/v1/actions/channel.create') {
        return Response.json({ action: 'channel.create', operationId: 'operation_server' });
      }
      if (url.pathname === '/v1/queries/channel.list') {
        return Response.json({ data: [], view: { bindings: {}, commands: [], kind: 'channel-list', schemaVersion: 'datagram/view@1', title: 'Channels' } });
      }
      if (url.pathname === '/v1/agent/queries/channel.list') {
        return Response.json({ id: 'result_server', expiresAt: '2099-01-01T00:00:00.000Z', purpose: 'channel.list', view: { bindings: {}, commands: [], kind: 'channel-list', schemaVersion: 'datagram/view@1' } });
      }
      return Response.json({ error: { code: 'test.unexpected' } }, { status: 404 });
    },
  };

  await runCli(['actions', '--profile', 'team'], host);
  await runCli(['queries', '--profile', 'team'], host);
  await runCli(['action', 'channel.create', '--profile', 'team'], host);
  await runCli(['query', 'channel.list'], host);
  await runCli(['agent-query', 'channel.list', '--profile', 'team'], host);

  expect(requested).toContain('POST /v1/actions/channel.create');
  expect(requested).toContain('POST /v1/queries/channel.list');
  expect(requested).toContain('POST /v1/agent/queries/channel.list');
  expect(output.join('')).toContain('operation_server');
  expect(output.join('')).toContain('result_server');
});

test('serve resolves its database from the selected Service profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-profile-serve-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const databasePath = join(directory, 'work.sqlite');
  runtime = await createRuntime({ databasePath: ':memory:' });
  await writeProfile(configuration, 'work', databasePath, runtime.owner.id, runtime.owner.displayName);

  const options: unknown[] = [];
  let terminationHandler: (() => void | Promise<void>) | undefined;
  const base = localSetupHost(configuration, join(directory, 'data'), [], []);
  const host: CliHost = {
    ...base,
    startHttpServer: (value) => {
      options.push(value);
      return Promise.resolve({
        identityMode: 'development',
        runtime: runtime!,
        server: { url: new URL('http://127.0.0.1:4310/'), stop: () => undefined },
      });
    },
    onTermination: (handler) => {
      terminationHandler = handler;
    },
  };

  await runCli(['serve', '--profile', 'work', '--port', '4310'], host);
  expect(options).toEqual([{ databasePath, port: 4310 }]);
  await terminationHandler?.();
  runtime = undefined;
});

test('profile selection fails actionably instead of guessing a Service target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-profile-errors-'));
  temporaryDirectories.push(directory);
  const host = localSetupHost(join(directory, 'configuration'), join(directory, 'data'), [], []);

  expect(runCli(['actions'], host)).rejects.toMatchObject({
    code: 'profile.selection-required',
    message: expect.stringContaining('--profile NAME'),
  });
  expect(runCli(['actions', '--profile', 'missing'], host)).rejects.toMatchObject({
    code: 'profile.not-found',
    message: expect.stringContaining('datagram init'),
  });
  expect(
    runCli(['actions', '--profile', 'personal', '--db', 'other.sqlite'], host),
  ).rejects.toMatchObject({ code: 'profile.target-conflict' });
});

test('doctor reports concise readiness without inspecting Channel data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-doctor-ready-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const databasePath = join(directory, 'ready.sqlite');
  const seeded = await createRuntime({ databasePath, ownerDisplayName: 'Ready Operator' });
  await writeProfile(
    configuration,
    'ready',
    databasePath,
    seeded.owner.id,
    seeded.owner.displayName,
  );
  await seeded.close();
  const output: string[] = [];

  await runCli(
    ['doctor', '--profile', 'ready'],
    localSetupHost(configuration, join(directory, 'data'), [], output),
  );

  expect(output.join('')).toBe(
    'profile: ok\ntarget: ok\nruntime: ok\nidentity: ok\n' +
      'Service ready. profile="ready" kind=local\nChannel data: not inspected\n',
  );
  expect(output.join('')).not.toContain('Ready Operator');
});

test('doctor gives a stable redacted profile failure and safe verbose context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-doctor-profile-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const profileDirectory = join(configuration, 'profiles');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(join(profileDirectory, 'broken.json'), '{"credential":"do-not-print"');
  const output: string[] = [];
  const exitCodes: number[] = [];
  const host: CliHost = {
    ...localSetupHost(configuration, join(directory, 'data'), [], output),
    setExitCode: (code) => exitCodes.push(code),
  };

  await runCli(['doctor', '--profile', 'broken', '--verbose'], host);

  const rendered = output.join('');
  expect(rendered).toContain('profile: failed');
  expect(rendered).toContain('Code: doctor.profile-unreadable');
  expect(rendered).toContain('Stage: profile');
  expect(rendered).toContain(
    'Recovery: Run `bunx prosto-datagram init --profile "broken"` to repair this profile.',
  );
  expect(rendered).toContain('causeCode="profile.invalid"');
  expect(rendered).not.toContain('do-not-print');
  expect(rendered).not.toContain('credential');
  expect(exitCodes).toEqual([1]);
});

test('doctor redacts runtime errors and reports the failing stage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-doctor-runtime-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const databasePath = join(directory, 'unavailable.sqlite');
  await writeFile(databasePath, 'present');
  await writeProfile(configuration, 'offline', databasePath, 'person_configured', 'Operator');
  const output: string[] = [];
  const host: CliHost = {
    ...localSetupHost(configuration, join(directory, 'data'), [], output),
    openRuntime: () => Promise.reject(new Error('password=do-not-print host=private-host')),
  };

  await runCli(['doctor', '--profile', 'offline', '--verbose'], host);

  const rendered = output.join('');
  expect(rendered).toContain('profile: ok');
  expect(rendered).toContain('target: ok');
  expect(rendered).toContain('runtime: failed');
  expect(rendered).toContain('Code: doctor.runtime-unready');
  expect(rendered).toContain('Stage: runtime');
  expect(rendered).toContain('adapter="sqlite"');
  expect(rendered).not.toContain('do-not-print');
  expect(rendered).not.toContain('private-host');
  expect(rendered).not.toContain('password');
});

test('doctor does not create a missing configured Store while diagnosing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-doctor-missing-store-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const databasePath = join(directory, 'missing.sqlite');
  await writeProfile(configuration, 'missing-store', databasePath, 'person_configured', 'Operator');
  const output: string[] = [];

  await runCli(
    ['doctor', '--profile', 'missing-store'],
    localSetupHost(configuration, join(directory, 'data'), [], output),
  );

  expect(output.join('')).toContain('Code: doctor.runtime-unready');
  expect(await pathExists(databasePath)).toBe(false);
});

test('doctor verifies identity without bootstrapping or exposing its configured value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-doctor-identity-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const databasePath = join(directory, 'empty.sqlite');
  const emptyRuntime = await openRuntime({ databasePath });
  await emptyRuntime.close();
  await writeProfile(
    configuration,
    'identity',
    databasePath,
    'person_secret-shaped-value',
    'Stored Display Value',
  );
  const output: string[] = [];
  const base = localSetupHost(configuration, join(directory, 'data'), [], output);
  const host: CliHost = {
    ...base,
    createRuntime: () => Promise.reject(new Error('doctor must not bootstrap an owner')),
  };

  await runCli(['doctor', '--profile', 'identity', '--verbose'], host);

  const rendered = output.join('');
  expect(rendered).toContain('identity: failed');
  expect(rendered).toContain('Code: doctor.identity-invalid');
  expect(rendered).toContain('Stage: identity');
  expect(rendered).toContain('causeCode="person.not-found"');
  expect(rendered).toContain('identityReference="configured"');
  expect(rendered).not.toContain('person_secret-shaped-value');
  expect(rendered).not.toContain('Stored Display Value');
});

test('legacy environment and explicit database and actor inputs remain compatible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-legacy-target-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'legacy.sqlite');
  const seeded = await createRuntime({ databasePath, ownerDisplayName: 'Legacy Operator' });
  const actorId = seeded.owner.id;
  await seeded.close();
  const output: string[] = [];
  const runtimeOptions: unknown[] = [];
  const base = localSetupHost(join(directory, 'configuration'), join(directory, 'data'), [], output);
  const host: CliHost = {
    ...base,
    currentDirectory: directory,
    environment: {
      get: (name) =>
        name === 'DATAGRAM_DB'
          ? 'legacy.sqlite'
          : name === 'DATAGRAM_ACTOR_ID'
            ? actorId
            : undefined,
    },
    createRuntime: async (options) => {
      runtimeOptions.push(options);
      return createRuntime(options);
    },
  };

  await runCli(
    ['action', 'channel.create', '--input', JSON.stringify({ title: 'Legacy', typeId: 'table' })],
    host,
  );
  await runCli(['query', 'channel.list', '--db', 'legacy.sqlite', '--actor', actorId], host);
  await runCli(['actions', '--db', ':memory:'], host);

  expect(runtimeOptions).toEqual([
    { databasePath },
    { databasePath },
    { databasePath: ':memory:' },
  ]);
  expect(JSON.parse(output.at(-2) ?? '')).toMatchObject({ data: [expect.any(Object)] });
});

test('guided init preserves verified core setup and resumes a failed starter recipe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-resume-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const failedOutput: string[] = [];

  await expect(
    runCli(
      ['init'],
      localSetupHost(
        configuration,
        data,
        ['', 'personal', 'Ada Lovelace', '', '', 'Launch plan', ''],
        failedOutput,
        undefined,
        'table.record.create',
      ),
    ),
  ).rejects.toMatchObject({ code: 'setup.starter-failed' });

  const profilePath = join(configuration, 'profiles', 'personal.json');
  const failedProfile = JSON.parse(await readFile(profilePath, 'utf8')) as {
    setup: { core: string; starter: { status: string; channelId: string } };
  };
  const failedChannelId = failedProfile.setup.starter.channelId;
  expect(failedProfile.setup).toMatchObject({
    core: 'verified',
    starter: { status: 'field-created', channelId: expect.stringMatching(/^channel_/) },
  });
  expect(failedOutput.join('')).toContain('Core setup remains ready.');
  expect(failedOutput.join('')).toContain('Resume: bunx prosto-datagram init');
  expect(await pathExists(join(data, 'profiles', 'personal', 'datagram.sqlite'))).toBe(true);

  const resumedOutput: string[] = [];
  await runCli(
    ['init'],
    localSetupHost(
      configuration,
      data,
      ['', '', 'Ship it'],
      resumedOutput,
    ),
  );

  const completedProfile = JSON.parse(await readFile(profilePath, 'utf8')) as {
    setup: { starter: { status: string; channelId: string } };
  };
  expect(completedProfile.setup.starter).toMatchObject({
    status: 'complete',
    channelId: failedChannelId,
  });
  expect(resumedOutput.join('')).toContain('Resume your first Table');

  runtime = await createRuntime({
    databasePath: join(data, 'profiles', 'personal', 'datagram.sqlite'),
  });
  expect(await runtime.store.listOperations(failedChannelId)).toEqual([
    expect.objectContaining({ action: 'channel.create', origin: 'cli' }),
    expect.objectContaining({ action: 'table.field.add', origin: 'cli' }),
    expect.objectContaining({ action: 'table.record.create', origin: 'cli' }),
  ]);
  expect(await runtime.store.listTableRecords(failedChannelId)).toEqual([
    expect.objectContaining({ values: { name: 'Ship it' } }),
  ]);
  expect(JSON.stringify(completedProfile)).not.toContain('Ship it');
  expect(JSON.stringify(completedProfile)).not.toContain('Launch plan');
});

test('rerunning complete setup inspects without repeating core or optional effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-rerun-complete-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  await runCli(
    ['init'],
    localSetupHost(
      configuration,
      data,
      ['', 'personal', 'Operator', '', '', 'Plans', 'First'],
      [],
    ),
  );
  const profilePath = join(configuration, 'profiles', 'personal.json');
  const journalPath = join(configuration, 'setup-journals', 'personal.json');
  const beforeProfile = await readFile(profilePath, 'utf8');
  const beforeJournal = await readFile(journalPath, 'utf8');
  const output: string[] = [];
  const base = localSetupHost(configuration, data, ['1'], output);
  const host: CliHost = {
    ...base,
    createRuntime: () => Promise.reject(new Error('complete setup must not bootstrap again')),
    runExternalCommand: () => Promise.reject(new Error('completed optional effects must not repeat')),
  };

  await runCli(['init', '--profile', 'personal'], host);

  expect(output.join('')).toContain('Existing setup detected');
  expect(output.join('')).toContain('Inspect only');
  expect(output.join('')).toContain('No changes made.');
  expect(await readFile(profilePath, 'utf8')).toBe(beforeProfile);
  expect(await readFile(journalPath, 'utf8')).toBe(beforeJournal);
});

test('planned setup resumes safely when interruption happened before profile persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-planned-resume-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const base = localSetupHost(
    configuration,
    data,
    ['', 'personal', 'Operator', '', ''],
    [],
  );
  await expect(
    runCli(['init'], {
      ...base,
      createRuntime: () => Promise.reject(new Error('interrupted before core applied')),
    }),
  ).rejects.toMatchObject({
    code: 'setup.core-failed',
    message: expect.stringContaining('init --profile "personal"'),
  });
  expect(await pathExists(join(configuration, 'profiles', 'personal.json'))).toBe(false);
  expect(
    JSON.parse(await readFile(join(configuration, 'setup-journals', 'personal.json'), 'utf8')),
  ).toMatchObject({ core: 'planned', failure: { code: 'setup.core-failed' } });

  await runCli(
    ['init', '--profile', 'personal'],
    localSetupHost(
      configuration,
      data,
      ['', '', 'Operator', '', '', 'Plans', 'First'],
      [],
    ),
  );
  expect(
    JSON.parse(await readFile(join(configuration, 'setup-journals', 'personal.json'), 'utf8')),
  ).toMatchObject({ core: 'verified', starter: { status: 'complete' } });
});

test('uncertain Action commit reconciles verified profile progress without repeating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-uncertain-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  await runCli(
    ['init'],
    localSetupHost(
      configuration,
      data,
      ['', 'personal', 'Operator', '', '', 'Plans', 'First'],
      [],
    ),
  );
  const journalPath = join(configuration, 'setup-journals', 'personal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    starter: {
      channelId: string;
      channelOperationId: string;
      fieldOperationId: string;
    };
  } & Record<string, unknown>;
  await writeFile(
    journalPath,
    `${JSON.stringify({
      ...journal,
      starter: {
        status: 'record-applying',
        channelId: journal.starter.channelId,
        channelOperationId: journal.starter.channelOperationId,
        fieldOperationId: journal.starter.fieldOperationId,
      },
    })}\n`,
  );
  const profilePath = join(configuration, 'profiles', 'personal.json');
  const profile = JSON.parse(
    await readFile(profilePath, 'utf8'),
  ) as { service: { databasePath: string }; setup: { starter: { channelId: string } } };
  await writeFile(
    profilePath,
    `${JSON.stringify({
      ...profile,
      setup: {
        core: 'verified',
        starter: {
          status: 'field-created',
          channelId: journal.starter.channelId,
          channelOperationId: journal.starter.channelOperationId,
          fieldOperationId: journal.starter.fieldOperationId,
        },
      },
    })}\n`,
  );
  runtime = await createRuntime({ databasePath: profile.service.databasePath });
  const before = await runtime.store.listOperations(profile.setup.starter.channelId);
  await runtime.close();
  runtime = undefined;

  const resumedOutput: string[] = [];
  await runCli(
    ['init', '--profile', 'personal'],
    localSetupHost(configuration, data, ['', ''], resumedOutput),
  );
  expect(resumedOutput.join('')).toContain('Reconciled committed starter Action');

  runtime = await createRuntime({ databasePath: profile.service.databasePath });
  expect(await runtime.store.listOperations(profile.setup.starter.channelId)).toHaveLength(
    before.length,
  );
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
    starter: { status: 'complete' },
  });
});

test('guided init cancellation before Apply leaves no profile or SQLite data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-cancel-'));
  temporaryDirectories.push(directory);
  const configuration = join(directory, 'configuration');
  const data = join(directory, 'data');
  const output: string[] = [];

  await runCli(
    ['init'],
    localSetupHost(configuration, data, ['', 'local', 'Grace Hopper', 'Cancel'], output),
  );

  expect(await pathExists(configuration)).toBe(false);
  expect(await pathExists(data)).toBe(false);
  expect(output.join('')).toContain('Setup cancelled. No changes were made.');
});

test('guided init rejects non-interactive input with recovery guidance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-guided-non-tty-'));
  temporaryDirectories.push(directory);
  const host = localSetupHost(join(directory, 'configuration'), join(directory, 'data'), [], []);
  Object.defineProperty(host.terminal, 'inputIsInteractive', { value: false });

  expect(runCli(['init'], host)).rejects.toMatchObject({
    code: 'setup.interactive-required',
    message: expect.stringContaining('bunx prosto-datagram init'),
  });
  expect(await pathExists(join(directory, 'configuration'))).toBe(false);
  expect(await pathExists(join(directory, 'data'))).toBe(false);

  const executable = await cli(['init']);
  expect(executable.exitCode).toBe(1);
  expect(JSON.parse(executable.stderr)).toEqual({
    error: {
      code: 'setup.interactive-required',
      message:
        '`datagram init` requires an interactive terminal. Open a terminal and run `bunx prosto-datagram init`.',
    },
  });
});

test('platform directories follow macOS and Linux user conventions', () => {
  expect(resolvePlatformDirectories('darwin', '/Users/ada', {})).toEqual({
    configuration: '/Users/ada/Library/Application Support/Prosto.Datagram',
    data: '/Users/ada/Library/Application Support/Prosto.Datagram',
  });
  expect(
    resolvePlatformDirectories('linux', '/home/ada', {
      XDG_CONFIG_HOME: '/configuration',
      XDG_DATA_HOME: '/data',
    }),
  ).toEqual({
    configuration: '/configuration/prosto-datagram',
    data: '/data/prosto-datagram',
  });
});

test('CLI discovers and invokes shared contracts with trusted Query results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'datagram.sqlite');
  runtime = await createRuntime({ databasePath: ':memory:' });

  const actions = await cli(['actions', '--db', databasePath]);
  expect(actions.exitCode).toBe(0);
  expect(JSON.parse(actions.stdout)).toEqual(runtime.app.actions.catalog());
  const queries = await cli(['queries', '--db', databasePath]);
  expect(queries.exitCode).toBe(0);
  expect(JSON.parse(queries.stdout)).toEqual(runtime.app.queries.catalog());
  const pinnedQueries = await cli([
    'queries',
    '--type-id',
    'table',
    '--type-version',
    '1.0.0',
    '--db',
    databasePath,
  ]);
  expect(pinnedQueries.exitCode).toBe(0);
  expect(JSON.parse(pinnedQueries.stdout)).toEqual(
    runtime.app.queries.catalog({ typeId: 'table', typeVersion: '1.0.0' }),
  );

  const created = await cli([
    'action',
    'channel.create',
    '--input',
    JSON.stringify({ title: 'CLI Table', typeId: 'table' }),
    '--db',
    databasePath,
  ]);
  expect(created.exitCode).toBe(0);
  const receipt = JSON.parse(created.stdout) as { subject: { id: string } };

  const queried = await cli(['query', 'channel.list', '--db', databasePath]);
  expect(queried.exitCode).toBe(0);
  const result = JSON.parse(queried.stdout) as { data: { id: string }[]; view: unknown };
  expect(result.data[0]?.id).toBe(receipt.subject.id);
  expect(result.view).toBeDefined();
});

test('CLI maps invalid input to safe structured errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-error-'));
  temporaryDirectories.push(directory);
  const result = await cli([
    'action',
    'channel.create',
    '--input',
    '{protected value',
    '--db',
    join(directory, 'datagram.sqlite'),
  ]);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'json.invalid', message: 'Invalid JSON input' },
  });
  expect(result.stderr).not.toContain('protected value');
  expect(result.stderr).not.toContain('at ');
});

test('CLI dispatch enforces selected Channel Type contract against input Channel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-cli-type-selection-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'datagram.sqlite');
  const created = await cli([
    'action',
    'channel.create',
    '--input',
    JSON.stringify({ title: 'Dictionary', typeId: 'dictionary' }),
    '--db',
    databasePath,
  ]);
  const channelId = (JSON.parse(created.stdout) as { subject: { id: string } }).subject.id;

  for (const [command, name, value] of [
    ['action', 'discussion.message.post', { channelId, text: 'wrong type' }],
    ['query', 'discussion.messages.list', { channelId }],
    ['agent-query', 'discussion.messages.list', { channelId }],
  ] as const) {
    const result = await cli([
      command,
      name,
      '--type-id',
      'table',
      '--type-version',
      '1.0.0',
      '--input',
      JSON.stringify(value),
      '--db',
      databasePath,
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'channel-type.version-mismatch' },
    });
  }
});
