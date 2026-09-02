import { expect, test } from 'bun:test';

import {
  createDockerPostgresPort,
  managedPostgresDefinition,
} from '../src/packages/cli';
import type { ExternalCommandRequest, ExternalCommandResult } from '../src/packages/cli';

test('Docker PostgreSQL provisioner creates persistent labelled infrastructure idempotently', async () => {
  const requests: ExternalCommandRequest[] = [];
  let created = false;
  let running = false;
  const definition = managedPostgresDefinition('team', 55432);
  const result = (stdout = '', exitCode = 0): ExternalCommandResult => ({
    exitCode,
    stdout,
    stderr: '',
  });
  const port = createDockerPostgresPort(async (request) => {
    requests.push(request);
    const args = request.args ?? [];
    if (args[0] === 'version') return result('27.0.0');
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!created) return result('', 1);
      return result(
        JSON.stringify([
          {
            Config: {
              Image: definition.image,
              Labels: {
                'io.prosto-datagram.managed': 'true',
                'io.prosto-datagram.profile': 'team',
              },
            },
            HostConfig: {
              PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55432' }] },
            },
            Mounts: [
              {
                Destination: '/var/lib/postgresql/data',
                Name: definition.volumeName,
                Type: 'volume',
              },
            ],
            State: { Running: running },
          },
        ]),
      );
    }
    if (args[0] === 'volume' && args[1] === 'inspect') return result('', 1);
    if (args[0] === 'run') {
      created = true;
      running = true;
    }
    if (args[0] === 'start') running = true;
    if (args[0] === 'stop') running = false;
    return result();
  });

  expect(await port.available()).toBe(true);
  await port.ensure({ ...definition, password: 'secret-not-output' });
  await port.ensure({ ...definition, password: 'different-unused-secret' });
  expect(await port.status(definition)).toBe('running');
  await port.stop(definition);
  expect(await port.status(definition)).toBe('stopped');
  await port.start(definition);
  expect(await port.status(definition)).toBe('running');

  const commands = requests.map(({ args }) => args ?? []);
  expect(commands.filter((args) => args[0] === 'run')).toHaveLength(1);
  expect(commands.filter((args) => args[0] === 'volume' && args[1] === 'create')).toHaveLength(1);
  expect(commands.flat()).not.toContain('rm');
  const run = commands.find((args) => args[0] === 'run') ?? [];
  expect(run).toContain('io.prosto-datagram.managed=true');
  expect(run).toContain('io.prosto-datagram.profile=team');
  expect(run).toContain(`${definition.volumeName}:/var/lib/postgresql/data`);
  expect(run).not.toContain('--rm');
});

test('Docker PostgreSQL provisioner refuses infrastructure owned by another profile', async () => {
  const definition = managedPostgresDefinition('team', 5432);
  const port = createDockerPostgresPort(() =>
    Promise.resolve({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        {
          Config: {
            Image: definition.image,
            Labels: {
              'io.prosto-datagram.managed': 'true',
              'io.prosto-datagram.profile': 'other',
            },
          },
          State: { Running: true },
        },
      ]),
    }),
  );

  expect(port.status(definition)).rejects.toMatchObject({ code: 'docker.postgres-invalid' });
});
