#!/usr/bin/env bun

import { createRuntime } from '../../runtime';
import { startHttpServer } from '../../server';

const args = Bun.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function input(): unknown {
  const raw = option('--input');
  return raw === undefined ? {} : JSON.parse(raw);
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): never {
  process.stderr.write(`Usage:
  datagram init [--db PATH]
  datagram actions|queries [--db PATH]
  datagram action NAME [--input JSON] [--actor ID] [--db PATH]
  datagram query NAME [--input JSON] [--actor ID] [--db PATH]
  datagram agent-query NAME [--input JSON] [--actor ID] [--db PATH]
  datagram serve [--port NUMBER] [--db PATH]
`);
  process.exit(1);
}

const command = args[0];
if (command === undefined || command === '--help' || command === '-h') help();

if (command === 'serve') {
  const rawPort = option('--port');
  const databasePath = option('--db');
  const { runtime, server } = await startHttpServer({
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(rawPort === undefined ? {} : { port: Number(rawPort) }),
  });
  process.stderr.write(`Datagram HTTP listening on ${server.url.toString()}\n`);
  const close = async () => {
    await server.stop();
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} else {
  const databasePath = option('--db');
  const runtime = await createRuntime({
    ...(databasePath === undefined ? {} : { databasePath }),
  });
  try {
    const actorId = option('--actor') ?? process.env.DATAGRAM_ACTOR_ID ?? runtime.owner.id;
    switch (command) {
      case 'init':
        output({ databasePath: databasePath ?? process.env.DATAGRAM_DB ?? 'datagram.sqlite', owner: runtime.owner });
        break;
      case 'actions':
        output(runtime.app.actions.list().map(({ description, name }) => ({ description, name })));
        break;
      case 'queries':
        output(runtime.app.queries.list().map(({ description, name }) => ({ description, name })));
        break;
      case 'action':
        output(
          await runtime.app.executeAction(
            actorId,
            'cli',
            required(args[1], 'Action name is required'),
            input(),
          ),
        );
        break;
      case 'query':
        output(
          await runtime.app.executeQuery(
            actorId,
            'cli',
            required(args[1], 'Query name is required'),
            input(),
          ),
        );
        break;
      case 'agent-query':
        output(
          await runtime.app.prepareQuery(
            actorId,
            'agent',
            required(args[1], 'Query name is required'),
            input(),
          ),
        );
        break;
      default:
        help();
    }
  } finally {
    await runtime.close();
  }
}
