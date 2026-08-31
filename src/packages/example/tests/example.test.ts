import { expect, test } from 'bun:test';

import { greetFromExample } from '../index';

test('exposes package behavior through its entry point', () => {
  expect(greetFromExample('  Datagram  User ')).toBe('Hello, Datagram User!');
});
