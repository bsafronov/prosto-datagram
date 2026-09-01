#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { resultHandleCompositionSchema } from '../../application';
import { createRuntime } from '../../runtime';

const runtimePromise = createRuntime();

serveStdio(async () => {
  const runtime = await runtimePromise;
  const actorId = process.env.DATAGRAM_ACTOR_ID ?? runtime.owner.id;
  const server = new McpServer(
    { name: 'prosto-datagram', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  for (const definition of runtime.app.actions.list()) {
    server.registerTool(
      definition.name,
      {
        annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (rawInput) => {
        const receipt = await runtime.app.executeAction(actorId, 'mcp', definition.name, rawInput);
        const output = { ...receipt };
        return {
          content: [{ text: JSON.stringify(output), type: 'text' }],
          structuredContent: output,
        };
      },
    );
  }

  for (const definition of runtime.app.queries.list()) {
    server.registerTool(
      definition.name,
      {
        annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
        description: `${definition.description} Returns an opaque Result Handle, never stored values.`,
        inputSchema: definition.inputSchema,
      },
      async (rawInput) => {
        const handle = await runtime.app.prepareQuery(actorId, 'mcp', definition.name, rawInput);
        const output = { ...handle };
        return {
          content: [{ text: JSON.stringify(output), type: 'text' }],
          structuredContent: output,
        };
      },
    );
  }

  server.registerTool(
    'result.compose',
    {
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
      description:
        'Deterministically filter, group, aggregate, or pass an opaque Result Handle. Returns no stored or derived values.',
      inputSchema: resultHandleCompositionSchema,
    },
    async (composition) => {
      const handle = await runtime.app.composeResultHandle(actorId, composition);
      const output = { ...handle };
      return {
        content: [{ text: JSON.stringify(output), type: 'text' }],
        structuredContent: output,
      };
    },
  );

  return server;
}, { onerror: (error) => process.stderr.write(`${error.message}\n`) });
