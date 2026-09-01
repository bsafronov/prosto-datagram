import { afterEach, describe, expect, test } from 'bun:test';

import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServer,
} from '@modelcontextprotocol/server';

import {
  AgentRuntimeError,
  createApiAgentRuntime,
  createCodexRuntime,
  getApprovalRequirement,
  type AgentRuntime,
  type AgentToolConnection,
  type AgentToolContract,
} from '../src/packages/agent-runtime';
import { createMcpGateway } from '../src/packages/mcp/gateway';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const open: { server: McpServer; service: DatagramRuntime }[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).flatMap(({ server, service }) => [server.close(), service.close()]),
  );
});

class McpClient {
  readonly #pending = new Map<number, (value: unknown) => void>();
  readonly #transport: InMemoryTransport;
  #requestId = 0;

  constructor(transport: InMemoryTransport) {
    this.#transport = transport;
    transport.onmessage = (message) => this.#receive(message);
  }

  async start(): Promise<void> {
    await this.#transport.start();
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'agent-runtime-test', version: '0.0.0' },
      protocolVersion: '2025-11-25',
    });
    await this.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#requestId;
    const response = new Promise<unknown>((resolve) => this.#pending.set(id, resolve));
    void this.#transport.send({ id, jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    return response;
  }

  #receive(message: JSONRPCMessage): void {
    if (!('id' in message) || 'method' in message || typeof message.id !== 'number') return;
    const resolve = this.#pending.get(message.id);
    if (!resolve) return;
    this.#pending.delete(message.id);
    resolve('error' in message ? { error: message.error } : message.result);
  }
}

async function personScopedMcp(): Promise<{
  service: DatagramRuntime;
  tools: AgentToolConnection;
}> {
  const service = await createRuntime({ databasePath: ':memory:' });
  const server = await createMcpGateway({
    app: service.app,
    authenticateIdentity: () => ({ actorId: service.owner.id }),
  });
  open.push({ server, service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpClient(clientTransport);
  await client.start();
  await server.connect(serverTransport);
  await client.initialize();
  return {
    service,
    tools: {
      callTool: (name, input) =>
        client.request('tools/call', { arguments: input, name }),
      listContracts: async () => {
        const result = (await client.request('tools/list')) as {
          tools: {
            annotations?: { readOnlyHint?: boolean };
            description?: string;
            inputSchema: unknown;
            name: string;
          }[];
        };
        return result.tools.map((tool) => ({
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          kind: tool.annotations?.readOnlyHint ? 'query' : 'action',
          name: tool.name,
        }));
      },
    },
  };
}

const factories = {
  api: (tools: AgentToolConnection) => createApiAgentRuntime({ tools }),
  codex: (tools: AgentToolConnection) => createCodexRuntime({ mcp: tools }),
};

for (const [runtimeName, factory] of Object.entries(factories)) {
  test(`${runtimeName} runtime orchestrates Channel, Dictionary, Table, and Chart via zero-data tools`, async () => {
    const { tools } = await personScopedMcp();
    const runtime = factory(tools);
    const contracts = await runtime.discover();
    expect(contracts.some(({ kind, name }) => kind === 'action' && name === 'chart.create')).toBe(
      true,
    );
    expect(
      contracts.some(({ kind, name }) => kind === 'query' && name === 'table.records.list'),
    ).toBe(true);

    const dictionary = await runtime.executeAction('channel.create', {
      title: 'PRIVATE_DICTIONARY_TITLE',
      typeId: 'dictionary',
    });
    const entry = await runtime.executeAction('dictionary.entry.create', {
      channelId: dictionary.subject!.id,
      label: 'PRIVATE_ENTRY_LABEL',
    });
    const table = await runtime.executeAction('channel.create', {
      title: 'PRIVATE_TABLE_TITLE',
      typeId: 'table',
    });
    await runtime.executeAction('table.field.add', {
      channelId: table.subject!.id,
      key: 'status',
      label: 'Private status',
      required: true,
      targetChannelId: dictionary.subject!.id,
      type: 'dictionary',
      unique: false,
    });
    await runtime.executeAction('table.record.create', {
      channelId: table.subject!.id,
      values: { status: entry.subject!.id },
    });
    const records = await runtime.executeQuery('table.records.list', {
      channelId: table.subject!.id,
      includeTombstoned: false,
      includeTombstonedFields: false,
    });
    const aggregation = await runtime.executeQuery('result.compose', {
      handleId: records.id,
      inputPurpose: records.purpose,
      outputPurpose: 'chart.create',
      transform: {
        aggregations: [{ as: 'count', operator: 'count' }],
        kind: 'aggregate',
      },
    });
    const chart = await runtime.executeAction('chart.create', {
      handleId: aggregation.id,
      presentation: { series: ['count'], type: 'bar' },
      title: 'PRIVATE_CHART_TITLE',
    });
    const opened = await runtime.executeQuery('chart.open', {
      channelId: chart.subject!.id,
    });

    const output = JSON.stringify({ aggregation, chart, dictionary, entry, opened, records, table });
    for (const value of [
      'PRIVATE_CHART_TITLE',
      'PRIVATE_DICTIONARY_TITLE',
      'PRIVATE_ENTRY_LABEL',
      'PRIVATE_TABLE_TITLE',
    ]) {
      expect(output).not.toContain(value);
    }
    expect(opened).not.toHaveProperty('data');
  });
}

describe('shared runtime safety policy', () => {
  const action: AgentToolContract = {
    description: 'Grant access',
    inputSchema: {},
    kind: 'action',
    name: 'channel.member.grant',
  };

  test('classifies bulk, destructive, costly, and access-expanding Actions', () => {
    expect(getApprovalRequirement('table.field.convert', {})).toMatchObject({
      reasons: ['bulk'],
    });
    expect(getApprovalRequirement('channel.purge', {})).toMatchObject({
      reasons: ['destructive'],
    });
    expect(getApprovalRequirement('integration.publish', {})).toMatchObject({
      reasons: ['costly'],
    });
    expect(getApprovalRequirement('channel.member.grant', {})).toMatchObject({
      reasons: ['access-expanding'],
    });
    expect(getApprovalRequirement('record.bulk-update', { records: ['one', 'two'] })).toMatchObject(
      { reasons: ['bulk'] },
    );
  });

  for (const [runtimeName, create] of Object.entries(factories)) {
    test(`${runtimeName} runtime requires approval before access-expanding Action`, async () => {
      let calls = 0;
      const tools: AgentToolConnection = {
        callTool: async () => {
          calls += 1;
          return { action: action.name, operationId: 'operation_unreachable' };
        },
        listContracts: async () => [action],
      };
      const runtime = create(tools);
      await expect(runtime.executeAction(action.name, {})).rejects.toMatchObject({
        code: 'approval.required',
      });
      expect(calls).toBe(0);
    });
  }

  test('approved Action invokes only shared tool connection and returns receipt', async () => {
    const approvals: unknown[] = [];
    let calls = 0;
    const runtime = createCodexRuntime({
      mcp: {
        callTool: async () => {
          calls += 1;
          return {
            action: action.name,
            operationId: 'operation_approved',
            storedValue: 'MUST_NOT_LEAK',
          };
        },
        listContracts: async () => [action],
      },
      requestApproval: (request) => {
        approvals.push(request);
        return true;
      },
    });
    const receipt = await runtime.executeAction(action.name, {});
    expect(receipt).toEqual({ action: action.name, operationId: 'operation_approved' });
    expect(approvals).toEqual([{ action: action.name, reasons: ['access-expanding'] }]);
    expect(calls).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain('MUST_NOT_LEAK');
  });

  test('runtime-specific failure is sanitized and never retried through another path', async () => {
    let calls = 0;
    const runtime: AgentRuntime = createApiAgentRuntime({
      tools: {
        callTool: async () => {
          calls += 1;
          throw new Error('PRIVATE_PROVIDER_OR_STORE_VALUE');
        },
        listContracts: async () => [
          { ...action, name: 'channel.create' },
        ],
      },
    });
    let caught: unknown;
    try {
      await runtime.executeAction('channel.create', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRuntimeError);
    expect(caught).toMatchObject({ code: 'runtime.tool-failed', message: 'Action failed' });
    expect(JSON.stringify(caught)).not.toContain('PRIVATE_PROVIDER_OR_STORE_VALUE');
    expect(calls).toBe(1);
  });
});
