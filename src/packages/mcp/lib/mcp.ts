#!/usr/bin/env bun

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createRuntime } from '../../runtime';
import { createMcpGateway } from '../gateway';

const runtimePromise = createRuntime();

serveStdio(
  async () => {
    const runtime = await runtimePromise;
    return createMcpGateway({
      app: runtime.app,
      authenticateIdentity: () => {
        const actorId = process.env.DATAGRAM_ACTOR_ID;
        return actorId === undefined ? undefined : { actorId };
      },
    });
  },
  { onerror: (error) => process.stderr.write(`${error.message}\n`) },
);
