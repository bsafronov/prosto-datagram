const suppliedUrl = process.env.DATAGRAM_TEST_POSTGRES_URL;
const containerName = `datagram-postgres-check-${crypto.randomUUID()}`;
const password = crypto.randomUUID();

async function command(
  argv: readonly string[],
  options: { readonly env?: Record<string, string | undefined>; readonly quiet?: boolean } = {},
): Promise<string> {
  const process = Bun.spawn(argv, {
    env: options.env ?? Bun.env,
    stderr: options.quiet ? 'pipe' : 'inherit',
    stdout: 'pipe',
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = process.stderr ? await new Response(process.stderr).text() : '';
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  }
  return stdout.trim();
}

async function runTests(connectionString: string): Promise<void> {
  await command(
    ['bun', 'test', 'test/postgres-store.test.ts', 'test/acceptance-journey.test.ts'],
    { env: { ...Bun.env, DATAGRAM_TEST_POSTGRES_URL: connectionString } },
  );
}

if (suppliedUrl) {
  await runTests(suppliedUrl);
} else {
  try {
    await command(['docker', 'version'], { quiet: true });
  } catch {
    throw new Error(
      'PostgreSQL verification is mandatory. Start Docker or set DATAGRAM_TEST_POSTGRES_URL.',
    );
  }

  try {
    await command([
      'docker',
      'run',
      '--rm',
      '--detach',
      '--name',
      containerName,
      '--env',
      'POSTGRES_DB=datagram',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_USER=datagram',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    ]);
    const address = await command(['docker', 'port', containerName, '5432/tcp']);
    const port = address.slice(address.lastIndexOf(':') + 1);
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await command(
          ['docker', 'exec', containerName, 'pg_isready', '--username', 'datagram', '--dbname', 'datagram'],
          { quiet: true },
        );
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(250);
      }
    }
    await runTests(
      `postgres://datagram:${password}@127.0.0.1:${port}/datagram?sslmode=disable`,
    );
  } finally {
    await command(['docker', 'rm', '--force', containerName], { quiet: true }).catch(() => {});
  }
}
