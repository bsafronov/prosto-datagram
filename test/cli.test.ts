import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
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
