#!/usr/bin/env bun

import { runCli, writeCliFailure } from './packages/cli';

try {
  await runCli(Bun.argv.slice(2));
} catch (error) {
  writeCliFailure(error);
  process.exitCode = 1;
}
