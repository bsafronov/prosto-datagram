#!/usr/bin/env bun

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createProcessCliHost } from '../../cli';
import { createMcpGateway } from '../gateway';
import { openMcpRuntimeTarget } from './profile-target';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: datagram-mcp [--profile NAME] [--check]\n');
  process.exit(0);
}

const runtimePromise = openMcpRuntimeTarget(args, createProcessCliHost());

if (args.includes('--check')) {
  try {
    const target = await runtimePromise;
    try {
      if (target.actorId === undefined) throw new Error('identity unavailable');
      await target.runtime.app.verifyServiceIdentity(target.actorId);
      process.stdout.write('Datagram MCP profile ready. Channel data not inspected.\n');
    } finally {
      await target.runtime.close();
    }
    process.exit(0);
  } catch {
    process.stderr.write('Datagram MCP profile check failed. Run `datagram doctor --profile NAME`.\n');
    process.exit(1);
  }
}

serveStdio(
  async () => {
    const target = await runtimePromise;
    return createMcpGateway({
      app: target.runtime.app,
      authenticateIdentity: () =>
        target.actorId === undefined ? undefined : { actorId: target.actorId },
    });
  },
  { onerror: (error) => process.stderr.write(`${error.message}\n`) },
);
