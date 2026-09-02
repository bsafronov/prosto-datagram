import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

async function run(command: readonly string[], cwd: string) {
  const child = Bun.spawn([...command], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

test('packed artifact exposes CLI and MCP executables and launches guided setup through bunx', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'datagram-package-'));
  temporaryDirectories.push(directory);
  const repository = join(import.meta.dir, '..');

  const packed = await run([process.execPath, 'pm', 'pack', '--destination', directory, '--quiet'], repository);
  expect(packed.exitCode).toBe(0);
  const tarball = packed.stdout.trim().split('\n').at(-1);
  expect(tarball).toBeTruthy();

  const unpacked = await run(['tar', '-xzf', tarball!, '-C', directory], directory);
  expect(unpacked.exitCode).toBe(0);
  const manifest = JSON.parse(await readFile(join(directory, 'package', 'package.json'), 'utf8')) as {
    private?: boolean;
    version: string;
    bin: Record<string, string>;
  };
  expect(manifest.private).toBeUndefined();
  expect(manifest.version).toBe('0.1.0');
  expect(manifest.bin).toEqual({ datagram: './src/cli.ts', 'datagram-mcp': './src/mcp.ts' });
  expect(await readFile(join(directory, 'package', 'src', 'cli.ts'), 'utf8')).toStartWith(
    '#!/usr/bin/env bun',
  );
  expect(await readFile(join(directory, 'package', 'src', 'mcp.ts'), 'utf8')).toStartWith(
    '#!/usr/bin/env bun',
  );

  const launched = await run(
    [process.execPath, 'x', '--package', tarball!, 'datagram', 'init'],
    directory,
  );
  expect(launched.exitCode).toBe(1);
  const cliError = launched.stderr
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('{'));
  expect(cliError).toBeTruthy();
  expect(JSON.parse(cliError!)).toEqual({
    error: {
      code: 'setup.interactive-required',
      message:
        '`datagram init` requires an interactive terminal. Open a terminal and run `bunx prosto-datagram init`.',
    },
  });
});
