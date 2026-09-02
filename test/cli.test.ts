import { afterEach, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cliUsage,
  resolvePlatformDirectories,
  runCli,
  type CliHost,
} from '../src/packages/cli';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

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
): CliHost {
  return {
    terminal: {
      input: scriptedInput(answers),
      inputIsInteractive: true,
      outputIsInteractive: true,
      writeOutput: (value) => output.push(value),
      writeError: () => undefined,
    },
    environment: { get: () => undefined },
    filesystem: {
      pathExists,
      readTextFile: (path) => readFile(path, 'utf8'),
      writeTextFile: (path, value, options) => writeFile(path, value, options),
      makeDirectory: (path, options) => mkdir(path, options).then(() => undefined),
    },
    directories: { configuration, data },
    currentDirectory: '/unrelated/current-directory',
    runExternalCommand,
    createRuntime,
    startHttpServer: () => Promise.reject(new Error('unexpected HTTP server')),
    onTermination: () => undefined,
    exit: () => undefined,
    setExitCode: () => undefined,
  };
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
    ['', 'discarded', 'Back', 'personal', 'Ada Lovelace', '', ''],
    output,
  );

  await runCli(['init'], host);

  const databasePath = join(data, 'profiles', 'personal', 'datagram.sqlite');
  const profilePath = join(configuration, 'profiles', 'personal.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as {
    version: number;
    name: string;
    service: { kind: string; databasePath: string };
    identity: { displayName: string; personId: string };
  };
  expect(profile).toEqual({
    version: 1,
    name: 'personal',
    service: { kind: 'local', databasePath },
    identity: {
      displayName: 'Ada Lovelace',
      personId: expect.stringMatching(/^person_/),
    },
  });
  expect(await readFile(join(configuration, 'default-profile'), 'utf8')).toBe('personal\n');
  expect(await pathExists(databasePath)).toBe(true);

  runtime = await createRuntime({ databasePath });
  expect(runtime.owner).toMatchObject({
    displayName: 'Ada Lovelace',
    id: profile.identity.personId,
    isOperator: true,
  });
  const rendered = output.join('');
  expect(rendered).toContain('Use on this machine (Recommended)');
  expect(rendered).toContain('Type Back');
  expect(rendered).toContain('[1/3] Creating Local Service');
  expect(rendered).toContain('[3/3] Verifying profile, Store, runtime, and identity');
  expect(rendered).toContain(`Configuration: ${profilePath}`);
  expect(rendered).toContain(`SQLite data: ${databasePath}`);
  expect(rendered).toContain(`CLI: bunx prosto-datagram actions --db ${JSON.stringify(databasePath)}`);
  expect(rendered).toContain('Durable commands: skipped');
  expect(rendered).toContain('bunx --package prosto-datagram datagram-mcp');
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
    ['', 'personal', 'Ada Lovelace', 'yes', 'yes'],
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
    ['', 'personal', 'Grace Hopper', 'yes', 'yes'],
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
