import { afterEach, expect, test } from 'bun:test';
import * as z from 'zod/v4';

import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServer,
} from '@modelcontextprotocol/server';

import { DatagramError } from '../src/packages/application/errors';
import { DatagramApplication } from '../src/packages/application';
import { bundledChannelTypes, ChannelTypeRegistry } from '../src/packages/domain/channel-types';
import { createMcpGateway } from '../src/packages/mcp/gateway';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';
import { SqliteStore } from '../src/packages/sqlite-store';

let runtime: DatagramRuntime | undefined;
let server: McpServer | undefined;
let customStore: SqliteStore | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await runtime?.close();
  runtime = undefined;
  await customStore?.close();
  customStore = undefined;
});

class McpTestClient {
  readonly #pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >();
  readonly #transport: InMemoryTransport;
  #requestId = 0;

  constructor(transport: InMemoryTransport) {
    this.#transport = transport;
    transport.onmessage = (message) => this.#receive(message);
  }

  async start(): Promise<void> {
    await this.#transport.start();
  }

  async initialize(): Promise<unknown> {
    const initialized = await this.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'datagram-test', version: '0.0.0' },
      protocolVersion: '2025-11-25',
    });
    await this.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return initialized;
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#requestId;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    void this.#transport.send({ id, jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    return response;
  }

  #receive(message: JSONRPCMessage): void {
    if (!('id' in message) || 'method' in message || typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if ('error' in message) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }
}

async function connect(channelType?: { typeId: string; typeVersion: string }) {
  runtime = await createRuntime({ databasePath: ':memory:' });
  server = await createMcpGateway({
    app: runtime.app,
    authenticateIdentity: () => ({ actorId: runtime!.owner.id }),
    ...(channelType ? { channelType } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpTestClient(clientTransport);
  await client.start();
  await server.connect(serverTransport);
  return { client, runtime };
}

test('MCP exposes only core and one exact Channel Type contract set', async () => {
  const value = await connect({ typeId: 'table', typeVersion: '1.0.0' });
  await value.client.initialize();
  const listed = (await value.client.request('tools/list')) as {
    tools: { name: string }[];
  };
  const names = listed.tools.map(({ name }) => name);
  expect(names).toContain('channel.list');
  expect(names).toContain('table.record.create');
  expect(names).toContain('discussion.message.post');
  expect(names).not.toContain('dictionary.entry.create');
  expect(names).not.toContain('chart.open');
});

test('MCP dispatch enforces selected Channel Type contract against input Channel', async () => {
  runtime = await createRuntime({ databasePath: ':memory:' });
  const created = await runtime.app.executeAction(
    runtime.owner.id,
    'cli',
    'channel.create',
    { title: 'Dictionary', typeId: 'dictionary' },
  );
  const channelId = created.subject!.id;
  server = await createMcpGateway({
    app: runtime.app,
    authenticateIdentity: () => ({ actorId: runtime!.owner.id }),
    channelType: { typeId: 'table', typeVersion: '1.0.0' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpTestClient(clientTransport);
  await client.start();
  await server.connect(serverTransport);
  await client.initialize();

  for (const [name, input] of [
    ['discussion.message.post', { channelId, text: 'wrong type' }],
    ['discussion.messages.list', { channelId }],
  ] as const) {
    const result = await call(client, name, input) as {
      isError: boolean;
      structuredContent: { error: { code: string } };
    };
    expect(result.isError).toBeTrue();
    expect(result.structuredContent.error.code).toBe('channel-type.version-mismatch');
  }
});

const call = (client: McpTestClient, name: string, args: Record<string, unknown>) =>
  client.request('tools/call', { arguments: args, name });

test('MCP requires authenticated identity mapped to an active Service person', async () => {
  runtime = await createRuntime({ databasePath: ':memory:' });

  await expect(
    createMcpGateway({ app: runtime.app, authenticateIdentity: () => undefined }),
  ).rejects.toMatchObject({ code: 'identity.unauthenticated' });
  await expect(
    createMcpGateway({
      app: runtime.app,
      authenticateIdentity: () => ({ actorId: 'person_missing' }),
    }),
  ).rejects.toMatchObject({ code: 'person.not-found' });
});

test('default MCP omits selector-required no-Channel type Queries', async () => {
  const definitions = bundledChannelTypes.map((definition) => definition.id === 'table' ? {
    ...definition,
    queries: [...definition.queries, {
      allowedOperations: [],
      authorization: { kind: 'operator' as const },
      execute: async () => ({ data: { ok: true }, view: { bindings: {}, commands: [], kind: 'test', schemaVersion: 'datagram/view@1' as const, title: 'Test' } }),
      inputSchema: z.object({}),
      name: 'table.selector-required',
    }],
    views: [...definition.views, {
      bindings: {},
      commands: [],
      kind: 'test',
      produce: () => ({ bindings: {}, commands: [], kind: 'test', schemaVersion: 'datagram/view@1' as const, title: 'Test' }),
      query: 'table.selector-required',
      title: 'Test',
    }],
  } : definition);
  customStore = new SqliteStore(':memory:');
  await customStore.initialize();
  const owner = await customStore.ensureLocalOwner();
  const app = new DatagramApplication(customStore, new ChannelTypeRegistry(definitions));
  server = await createMcpGateway({ app, authenticateIdentity: () => ({ actorId: owner.id }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpTestClient(clientTransport);
  await client.start();
  await server.connect(serverTransport);
  await client.initialize();
  const listed = await client.request('tools/list') as { tools: { name: string }[] };
  expect(listed.tools.map((tool) => tool.name)).not.toContain('table.selector-required');
  await expect(call(client, 'table.selector-required', {})).rejects.toThrow('Tool table.selector-required not found');
});

test('MCP initializes, discovers every shared contract, and executes Actions and Queries', async () => {
  const value = await connect();
  const initialized = await value.client.initialize();
  expect(initialized).toMatchObject({
    capabilities: { tools: {} },
    serverInfo: { name: 'prosto-datagram' },
  });

  const listed = (await value.client.request('tools/list')) as {
    tools: { inputSchema: unknown; name: string }[];
  };
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  expect([...tools.keys()].sort()).toEqual(
    [
      ...value.runtime.app.actions.catalog().map(({ name }) => name),
      ...value.runtime.app.queries.catalog().map(({ name }) => name),
      'result.compose',
    ].sort(),
  );
  for (const contract of [
    ...value.runtime.app.actions.catalog(),
    ...value.runtime.app.queries.catalog(),
  ]) {
    expect(tools.get(contract.name)?.inputSchema).toMatchObject({ type: 'object' });
  }

  const marker = 'STORED_VALUE_MUST_NOT_LEAK';
  const created = (await call(value.client, 'channel.create', {
    title: marker,
    typeId: 'table',
  })) as { structuredContent: { subject: { id: string } } };
  expect(JSON.stringify(created)).not.toContain(marker);
  expect(created.structuredContent).toMatchObject({
    action: 'channel.create',
    operationId: expect.any(String),
    subject: { id: expect.any(String), kind: 'channel' },
  });

  const queried = (await call(value.client, 'channel.list', {})) as {
    structuredContent: {
      expiresAt: string;
      id: string;
      purpose: string;
      view: Record<string, unknown>;
    };
  };
  expect(JSON.stringify(queried)).not.toContain(marker);
  expect(queried.structuredContent).toEqual({
    expiresAt: expect.any(String),
    id: expect.any(String),
    purpose: 'channel.list',
    view: {
      bindings: expect.any(Object),
      commands: expect.any(Array),
      kind: expect.any(String),
      schemaVersion: 'datagram/view@1',
    },
  });
  expect(queried.structuredContent).not.toHaveProperty('data');
  expect(queried.structuredContent.view).not.toHaveProperty('title');
});

test('MCP success and error output never leaks stored or derived values', async () => {
  const value = await connect();
  await value.client.initialize();
  const storedMarker = 'PRIVATE_STORED_MARKER';
  const derivedMarker = 'PRIVATE_DERIVED_MARKER';
  const outputs: unknown[] = [];

  outputs.push(
    await call(value.client, 'channel.create', { title: storedMarker, typeId: 'table' }),
  );
  const source = (await call(value.client, 'channel.list', {})) as {
    structuredContent: { id: string; purpose: string };
  };
  outputs.push(source);
  outputs.push(
    await call(value.client, 'result.compose', {
      handleId: source.structuredContent.id,
      inputPurpose: source.structuredContent.purpose,
      outputPurpose: 'chart.input',
      transform: {
        aggregations: [{ as: derivedMarker, operator: 'count' }],
        kind: 'aggregate',
      },
    }),
  );

  Object.defineProperty(value.runtime.app, 'executeAction', {
    configurable: true,
    value: async () => {
      throw new DatagramError('test.action-failed', storedMarker);
    },
  });
  Object.defineProperty(value.runtime.app, 'prepareQuery', {
    configurable: true,
    value: async () => {
      throw new DatagramError('test.query-failed', derivedMarker);
    },
  });
  outputs.push(await call(value.client, 'channel.create', { title: 'safe', typeId: 'table' }));
  outputs.push(await call(value.client, 'channel.list', {}));

  const serialized = JSON.stringify(outputs);
  expect(serialized).not.toContain(storedMarker);
  expect(serialized).not.toContain(derivedMarker);
  expect(serialized).not.toContain('stack');
  expect(outputs.at(-2)).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: 'test.action-failed', message: 'Action failed' },
    },
  });
  expect(outputs.at(-1)).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: 'test.query-failed', message: 'Query failed' },
    },
  });
});
