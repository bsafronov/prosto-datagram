const suppliedUrl = process.env.DATAGRAM_TEST_POSTGRES_URL;
const containerName = `datagram-postgres-check-${crypto.randomUUID()}`;
const password = crypto.randomUUID();
const readinessTimeoutMs = 30_000;
const postgresImage =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const postgresProbe = `
  import { SQL } from 'bun';

  const client = new SQL(process.env.DATAGRAM_TEST_POSTGRES_URL!);
  try {
    await client\`SELECT 1\`;
  } finally {
    await client.close();
  }
`;

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
    [
      'bun',
      'test',
      'test/postgres-store.test.ts',
      'test/acceptance-journey.test.ts',
      'test/packaged-setup.test.ts',
    ],
    { env: { ...Bun.env, DATAGRAM_TEST_POSTGRES_URL: connectionString } },
  );
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + readinessTimeoutMs;
  while (true) {
    try {
      await command(['bun', '-e', postgresProbe], {
        env: { ...Bun.env, DATAGRAM_TEST_POSTGRES_URL: connectionString },
        quiet: true,
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(250);
    }
  }
}

if (suppliedUrl) {
  await waitForPostgres(suppliedUrl);
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
      postgresImage,
    ]);
    const address = await command(['docker', 'port', containerName, '5432/tcp']);
    const port = address.slice(address.lastIndexOf(':') + 1);
    const connectionString =
      `postgres://datagram:${password}@127.0.0.1:${port}/datagram?sslmode=disable`;
    await waitForPostgres(connectionString);
    await runTests(connectionString);
  } finally {
    await command(['docker', 'rm', '--force', containerName], { quiet: true }).catch(() => {});
  }
}
