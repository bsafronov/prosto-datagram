#!/usr/bin/env bun

import { createProcessCliHost, runCli, writeCliFailure } from './packages/cli';

const host = createProcessCliHost();
try {
  await runCli(Bun.argv.slice(2), host);
} catch (error) {
  writeCliFailure(error, host);
  host.setExitCode(1);
}
