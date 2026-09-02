import { afterEach, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyCodexIntegration,
  discoverCodexIntegration,
  runCli,
  type CliHost,
  type ExternalCommandRequest,
} from '../src/packages/cli';
import { openMcpRuntimeTarget } from '../src/packages/mcp/target';
import { createHttpHandler } from '../src/packages/http';
import { createRuntime, openRuntime } from '../src/packages/runtime';

const temporaryDirectories: string[] = [];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hostAt(
  root: string,
  runExternalCommand: CliHost['runExternalCommand'],
  output: string[] = [],
  answers: readonly string[] = [],
): CliHost {
  return {
    terminal: {
      input: {
        async *[Symbol.asyncIterator]() {
          for (const answer of answers) yield `${answer}\n`;
        },
      },
      inputIsInteractive: true,
      outputIsInteractive: true,
      writeOutput: (value) => output.push(value),
      writeError: () => undefined,
    },
    environment: { get: () => undefined },
    filesystem: {
      pathExists: exists,
      readTextFile: (path) => readFile(path, 'utf8'),
      writeTextFile: (path, value, options) => writeFile(path, value, options),
      writeTextFileAtomic: async (path, value, options) => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, value, options);
        await rename(temporary, path);
      },
      makeDirectory: (path, options) => mkdir(path, options).then(() => undefined),
      canWritePath: () => Promise.resolve(true),
      isSymbolicLink: () => Promise.resolve(false),
    },
    directories: {
      configuration: join(root, 'configuration'),
      data: join(root, 'data'),
      agentSkills: join(root, '.agents', 'skills'),
    },
    currentDirectory: root,
    runExternalCommand,
    createRuntime,
    openRuntime,
    startHttpServer: () => Promise.reject(new Error('unexpected HTTP server')),
    onTermination: () => undefined,
    exit: () => undefined,
    setExitCode: () => undefined,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

test('Codex discovery hides an unavailable integration with an actionable reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-codex-unavailable-'));
  temporaryDirectories.push(root);
  const host = hostAt(root, ({ command }) =>
    Promise.resolve({
      exitCode: command === 'codex' ? 127 : 0,
      stdout: '',
      stderr: 'credential_marker_must_not_escape',
    }),
  );

  const discovery = await discoverCodexIntegration(host, 'personal', true);

  expect(discovery).toEqual({ available: false, reason: 'compatible Codex CLI was not found' });
  expect(JSON.stringify(discovery)).not.toContain('credential_marker');
});

test('Connect Codex installs the owned skill and registers one profile-scoped MCP without changing unrelated configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-codex-success-'));
  temporaryDirectories.push(root);
  const unrelated = join(root, '.agents', 'skills', 'other-skill', 'SKILL.md');
  await mkdir(join(root, '.agents', 'skills', 'other-skill'), { recursive: true });
  await writeFile(unrelated, 'keep me');
  let registered = false;
  const requests: ExternalCommandRequest[] = [];
  const host = hostAt(root, (request) => {
    requests.push(request);
    if (request.command === 'codex' && request.args?.[0] === '--version') {
      return Promise.resolve({ exitCode: 0, stdout: 'codex-cli 1.2.3', stderr: '' });
    }
    if (request.command === 'datagram-mcp') {
      return Promise.resolve({ exitCode: 0, stdout: 'Usage: datagram-mcp [--profile NAME]', stderr: '' });
    }
    if (request.command === 'codex' && request.args?.[1] === 'list') {
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'unrelated', command: 'other-mcp', args: [] },
          ...(registered
            ? [{ name: 'datagram-personal', command: 'datagram-mcp', args: ['--profile', 'personal'] }]
            : []),
        ]),
        stderr: '',
      });
    }
    if (request.command === 'codex' && request.args?.[1] === 'add') {
      registered = true;
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: '' });
  });
  const discovery = await discoverCodexIntegration(host, 'personal', true);
  expect(discovery.available).toBe(true);
  if (!discovery.available) throw new Error('expected available integration');

  const result = await applyCodexIntegration(host, discovery.plan);
  const rerun = await applyCodexIntegration(host, discovery.plan, result.progress);

  expect(result.status).toBe('verified');
  expect(rerun.status).toBe('verified');
  expect(await readFile(unrelated, 'utf8')).toBe('keep me');
  expect(await readFile(join(root, '.agents', 'skills', 'prosto-datagram', 'SKILL.md'), 'utf8')).toContain('name: prosto-datagram');
  expect(requests.filter((request) => request.args?.[1] === 'add')).toEqual([
    {
      command: 'codex',
      args: ['mcp', 'add', 'datagram-personal', '--', 'datagram-mcp', '--profile', 'personal'],
    },
  ]);
  expect(JSON.stringify(discovery.plan)).not.toContain('person_');
});

test('Connect Codex reports one resumable partial failure after installing the skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-codex-partial-'));
  temporaryDirectories.push(root);
  let addAttempts = 0;
  let registered = false;
  const host = hostAt(root, ({ command, args }) => {
    if (command === 'codex' && args?.[0] === '--version') {
      return Promise.resolve({ exitCode: 0, stdout: 'codex-cli 1', stderr: '' });
    }
    if (command === 'datagram-mcp') return Promise.resolve({ exitCode: 0, stdout: 'Usage', stderr: '' });
    if (command === 'codex' && args?.[1] === 'list') {
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(
          registered
            ? [{ name: 'datagram-team', command: 'datagram-mcp', args: ['--profile', 'team'] }]
            : [],
        ),
        stderr: '',
      });
    }
    if (command === 'codex' && args?.[1] === 'add') {
      addAttempts += 1;
      registered = addAttempts > 1;
      return Promise.resolve({ exitCode: registered ? 0 : 9, stdout: '', stderr: 'secret details' });
    }
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: '' });
  });
  const discovery = await discoverCodexIntegration(host, 'team', true);
  if (!discovery.available) throw new Error('expected available integration');

  const partial = await applyCodexIntegration(host, discovery.plan);
  const resumed = await applyCodexIntegration(host, discovery.plan, partial.progress);

  expect(partial).toMatchObject({
    status: 'partial',
    progress: { skill: 'verified', mcp: 'pending' },
    summary: expect.stringContaining('skill installed; MCP registration failed'),
  });
  expect(JSON.stringify(partial)).not.toContain('secret details');
  expect(resumed.status).toBe('verified');
  expect(addAttempts).toBe(2);
});

test('guided setup reviews and completes Connect Codex after core setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-codex-guided-'));
  temporaryDirectories.push(root);
  let registered = false;
  const output: string[] = [];
  const host = hostAt(
    root,
    ({ command, args }) => {
      if (command === 'bun' && args?.[0] === 'pm') {
        return Promise.resolve({ exitCode: 0, stdout: `${join(root, 'bin')}\n`, stderr: '' });
      }
      if (command === 'bun') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      if (command === 'codex' && args?.[0] === '--version') {
        return Promise.resolve({ exitCode: 0, stdout: 'codex-cli 1', stderr: '' });
      }
      if (command === 'datagram-mcp') return Promise.resolve({ exitCode: 0, stdout: 'Usage', stderr: '' });
      if (command === 'codex' && args?.[1] === 'list') {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify(
            registered
              ? [{ name: 'datagram-personal', command: 'datagram-mcp', args: ['--profile', 'personal'] }]
              : [],
          ),
          stderr: '',
        });
      }
      if (command === 'codex' && args?.[1] === 'add') {
        registered = true;
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 127, stdout: '', stderr: '' });
    },
    output,
    ['', 'personal', 'Operator', 'yes', 'yes', 'Plans', 'First', 'yes'],
  );

  await runCli(['init'], host);

  const rendered = output.join('');
  expect(rendered).toContain('[optional] Connect Codex');
  expect(rendered).toContain('Credential reference: selected Service profile identity (redacted)');
  expect(rendered).toContain('Connect Codex: verified');
  expect(rendered).toContain('Codex integration: verified');
  expect(
    JSON.parse(await readFile(join(root, 'configuration', 'setup-journals', 'personal.json'), 'utf8')),
  ).toMatchObject({ core: 'verified', codex: { status: 'verified' } });
});

test('guided setup resumes only the failed Codex component after core setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-codex-guided-resume-'));
  temporaryDirectories.push(root);
  let addAttempts = 0;
  let registered = false;
  const commands = ({ command, args }: ExternalCommandRequest) => {
    if (command === 'bun' && args?.[0] === 'pm') {
      return Promise.resolve({ exitCode: 0, stdout: `${join(root, 'bin')}\n`, stderr: '' });
    }
    if (command === 'bun' || command === 'datagram-mcp') {
      return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
    }
    if (command === 'codex' && args?.[0] === '--version') {
      return Promise.resolve({ exitCode: 0, stdout: 'codex-cli 1', stderr: '' });
    }
    if (command === 'codex' && args?.[1] === 'list') {
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(
          registered
            ? [{ name: 'datagram-personal', command: 'datagram-mcp', args: ['--profile', 'personal'] }]
            : [],
        ),
        stderr: '',
      });
    }
    if (command === 'codex' && args?.[1] === 'add') {
      addAttempts += 1;
      registered = addAttempts > 1;
      return Promise.resolve({ exitCode: registered ? 0 : 7, stdout: '', stderr: '' });
    }
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: '' });
  };
  const firstOutput: string[] = [];
  await runCli(
    ['init'],
    hostAt(
      root,
      commands,
      firstOutput,
      ['', 'personal', 'Operator', 'yes', 'yes', 'Plans', 'First', 'yes'],
    ),
  );
  expect(firstOutput.join('')).toContain('Connect Codex: partial failure');

  const resumedOutput: string[] = [];
  await runCli(
    ['init', '--profile', 'personal'],
    hostAt(root, commands, resumedOutput, ['', '', 'yes']),
  );

  expect(resumedOutput.join('')).toContain('Service: ready; Codex: skill-installed');
  expect(resumedOutput.join('')).toContain('Connect Codex: verified');
  expect(addAttempts).toBe(2);
  expect(
    JSON.parse(await readFile(join(root, 'configuration', 'setup-journals', 'personal.json'), 'utf8')),
  ).toMatchObject({ core: 'verified', codex: { status: 'verified' } });
});

test('Connect Codex refuses to overwrite an unrelated same-name skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-codex-conflict-'));
  temporaryDirectories.push(root);
  const destination = join(root, '.agents', 'skills', 'prosto-datagram');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'SKILL.md'), 'user-owned content');
  const host = hostAt(root, ({ command, args }) => {
    if (command === 'codex' && args?.[0] === '--version') {
      return Promise.resolve({ exitCode: 0, stdout: 'codex-cli 1', stderr: '' });
    }
    if (command === 'datagram-mcp') return Promise.resolve({ exitCode: 0, stdout: 'Usage', stderr: '' });
    return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
  });
  const discovery = await discoverCodexIntegration(host, 'personal', true);
  if (!discovery.available) throw new Error('expected available integration');

  const result = await applyCodexIntegration(host, discovery.plan);

  expect(result).toMatchObject({ status: 'partial', progress: { skill: 'pending', mcp: 'pending' } });
  expect(result.summary).toContain('existing skill is not Datagram-owned');
  expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('user-owned content');
});

test('profile-scoped MCP opens existing Service identity and preserves zero-data query output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-mcp-profile-'));
  temporaryDirectories.push(root);
  const databasePath = join(root, 'datagram.sqlite');
  const seeded = await createRuntime({ databasePath, ownerDisplayName: 'Stored Person' });
  const personId = seeded.owner.id;
  await seeded.app.executeAction(personId, 'cli', 'channel.create', { title: 'Stored Title', typeId: 'table' });
  await seeded.close();
  await mkdir(join(root, 'configuration', 'profiles'), { recursive: true });
  await writeFile(
    join(root, 'configuration', 'profiles', 'personal.json'),
    `${JSON.stringify({
      version: 1,
      name: 'personal',
      service: { kind: 'local', databasePath },
      identity: { personId, displayName: 'Stored Person' },
    })}\n`,
  );
  const host = hostAt(root, () => Promise.reject(new Error('unexpected command')));

  const target = await openMcpRuntimeTarget(['--profile', 'personal'], host);
  try {
    expect(target.actorId).toBe(personId);
    const result = await target.runtime.app.prepareQuery(
      target.actorId ?? '',
      'agent',
      'channel.list',
      {},
    );
    expect(result).toMatchObject({ id: expect.stringMatching(/^result_/), purpose: 'channel.list' });
    expect(JSON.stringify(result)).not.toContain('Stored Title');
    expect(JSON.stringify(result)).not.toContain('Stored Person');
  } finally {
    await target.runtime.close();
  }
});

test('profile-scoped MCP reaches a Server Service through authenticated HTTP only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-mcp-server-profile-'));
  temporaryDirectories.push(root);
  const service = await createRuntime({ databasePath: ':memory:', ownerDisplayName: 'Server Person' });
  const handler = createHttpHandler({
    app: service.app,
    verifyIdentity: (request) =>
      request.headers.get('authorization') === 'Bearer server-secret'
        ? { actorId: service.owner.id }
        : undefined,
  });
  await mkdir(join(root, 'configuration', 'profiles'), { recursive: true });
  await writeFile(
    join(root, 'configuration', 'profiles', 'team.json'),
    `${JSON.stringify({
      version: 1,
      name: 'team',
      service: {
        kind: 'server',
        infrastructure: { kind: 'external-postgres' },
        serviceKey: 'service_team',
        postgres: { credential: { kind: 'environment', name: 'TEST_POSTGRES_URL' } },
        bind: { exposure: 'host', hostname: '127.0.0.1', port: 3100 },
      },
      identity: {
        personId: service.owner.id,
        displayName: 'Server Person',
        bearerCredential: { kind: 'environment', name: 'TEST_BEARER' },
      },
    })}\n`,
  );
  const base = hostAt(root, () => Promise.reject(new Error('unexpected command')));
  const host: CliHost = {
    ...base,
    environment: {
      get: (name) => (name === 'TEST_BEARER' ? 'server-secret' : undefined),
    },
    request: handler,
  };

  const target = await openMcpRuntimeTarget(['--profile', 'team'], host);
  try {
    const receipt = await target.runtime.app.executeAction(
      target.actorId ?? '',
      'mcp',
      'channel.create',
      { title: 'Remote Stored Title', typeId: 'table' },
    );
    expect(receipt).toMatchObject({ action: 'channel.create', operationId: expect.any(String) });
    const result = await target.runtime.app.prepareQuery(
      target.actorId ?? '',
      'mcp',
      'channel.list',
      {},
    );
    expect(result).toMatchObject({ id: expect.stringMatching(/^result_/), purpose: 'channel.list' });
    expect(JSON.stringify(result)).not.toContain('Remote Stored Title');
    expect(JSON.stringify(target)).not.toContain('server-secret');
  } finally {
    await target.runtime.close();
    await service.close();
  }
});

test('Doctor checks configured Codex control metadata without returning Service values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datagram-doctor-codex-'));
  temporaryDirectories.push(root);
  const databasePath = join(root, 'datagram.sqlite');
  const seeded = await createRuntime({ databasePath, ownerDisplayName: 'Stored Person' });
  const personId = seeded.owner.id;
  await seeded.close();
  await mkdir(join(root, 'configuration', 'profiles'), { recursive: true });
  await mkdir(join(root, 'configuration', 'setup-journals'), { recursive: true });
  await writeFile(
    join(root, 'configuration', 'profiles', 'personal.json'),
    `${JSON.stringify({ version: 1, name: 'personal', service: { kind: 'local', databasePath }, identity: { personId, displayName: 'Stored Person' } })}\n`,
  );
  const commands = (request: ExternalCommandRequest) => {
    if (request.args?.[0] === '--version' || request.command === 'datagram-mcp') {
      return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify([{ name: 'datagram-personal', command: 'datagram-mcp', args: ['--profile', 'personal'] }]),
      stderr: '',
    });
  };
  const output: string[] = [];
  const host = hostAt(root, commands, output);
  const discovery = await discoverCodexIntegration(host, 'personal', true);
  if (!discovery.available) throw new Error('expected available integration');
  expect((await applyCodexIntegration(host, discovery.plan)).status).toBe('verified');
  await writeFile(
    join(root, 'configuration', 'setup-journals', 'personal.json'),
    `${JSON.stringify({ version: 1, profileName: 'personal', core: 'verified', starter: { status: 'pending' }, durableInstall: 'skipped', codex: { status: 'verified' } })}\n`,
  );

  await runCli(['doctor', '--profile', 'personal', '--verbose'], host);

  const rendered = output.join('');
  expect(rendered).toContain('codex: ok');
  expect(rendered).toContain('Channel data: not inspected');
  expect(rendered).not.toContain(personId);
  expect(rendered).not.toContain('Stored Person');
});
