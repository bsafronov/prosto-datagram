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
    'Recovery: Run `bunx prosto-datagram init` to repair profile "broken".',
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
      ['', 'personal', 'Ada Lovelace', '', '', 'Ship it'],
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
