import { expect, test } from 'bun:test';

import {
  createNativeCredentialProvider,
  type CredentialCommandRequest,
} from '../src/packages/cli/credentials';

const marker = ['never', 'print', 'this'].join('-');

test('macOS Keychain adapter creates, resolves, and updates through an input-safe native bridge', async () => {
  const requests: CredentialCommandRequest[] = [];
  const provider = createNativeCredentialProvider('darwin', (request) => {
    requests.push(request);
    const operation = request.args[2];
    if (operation === 'resolve') return Promise.resolve({ exitCode: 0, stdout: marker, stderr: '' });
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
  if (provider === undefined) throw new Error('expected macOS provider');

  expect(await provider.availability()).toEqual({ available: true });
  const reference = await provider.create({ account: 'team:postgres', label: 'PostgreSQL', secret: marker });
  expect(await provider.resolve(reference)).toBe(marker);
  await provider.update(reference, marker);

  expect(reference).toEqual({
    kind: 'native',
    provider: 'macos-keychain',
    service: 'prosto-datagram',
    account: 'team:postgres',
  });
  expect(requests.filter((request) => request.stdin === marker)).toHaveLength(2);
  expect(JSON.stringify(requests.map(({ stdin: _stdin, ...request }) => request))).not.toContain(marker);
});

test('Linux Secret Service adapter verifies the session and never puts secrets in arguments', async () => {
  const requests: CredentialCommandRequest[] = [];
  const provider = createNativeCredentialProvider('linux', (request) => {
    requests.push(request);
    if (request.args[0] === 'lookup') {
      return Promise.resolve({ exitCode: 0, stdout: `${marker}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
  if (provider === undefined) throw new Error('expected Linux provider');

  expect(await provider.availability()).toEqual({ available: true });
  const reference = await provider.create({ account: 'team:operator', label: 'Operator', secret: marker });
  expect(await provider.resolve(reference)).toBe(marker);
  await provider.update(reference, marker);

  expect(requests[0]).toMatchObject({
    command: 'secret-tool',
    args: ['--help'],
  });
  expect(requests[1]).toMatchObject({
    command: 'gdbus',
    args: expect.arrayContaining(['--session', 'org.freedesktop.secrets']),
  });
  expect(requests.filter((request) => request.stdin === marker)).toHaveLength(2);
  expect(JSON.stringify(requests.map(({ stdin: _stdin, ...request }) => request))).not.toContain(marker);
});

test('native provider unavailability and command failures are explicit and redacted', async () => {
  const unavailable = createNativeCredentialProvider('linux', (request) =>
    Promise.resolve({
      exitCode: request.command === 'secret-tool' && request.args[0] === '--help' ? 0 : 1,
      stdout: marker,
      stderr: marker,
    }),
  );
  if (unavailable === undefined) throw new Error('expected Linux provider');
  expect(await unavailable.availability()).toEqual({
    available: false,
    reason: 'Linux Secret Service has no usable unlocked user session.',
  });

  try {
    await unavailable.create({ account: 'team:operator', label: 'Operator', secret: marker });
    throw new Error('expected native create failure');
  } catch (error) {
    expect(error).toMatchObject({ code: 'credential.native-create-failed' });
    expect(String((error as Error).message)).not.toContain(marker);
  }

  const reference = {
    kind: 'native' as const,
    provider: 'linux-secret-service' as const,
    service: 'prosto-datagram' as const,
    account: 'team:operator',
  };
  for (const operation of [
    () => unavailable.resolve(reference),
    () => unavailable.update(reference, marker),
  ]) {
    try {
      await operation();
      throw new Error('expected native credential failure');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(marker);
    }
  }
  expect(createNativeCredentialProvider('win32', () => Promise.reject())).toBeUndefined();
});
