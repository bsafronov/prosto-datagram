import { McpServer } from '@modelcontextprotocol/server';

import { resultHandleCompositionSchema } from '../../application';
import type { IssuedResultHandle } from '../../application';
import type { ChannelTypeContractSelector } from '../../application/contracts';
import { DatagramError } from '../../application/errors';
import type { DatagramApplicationPort } from '../../application/port';

export interface AuthenticatedMcpIdentity {
  readonly actorId: string;
}

export type McpIdentityAuthenticator = () =>
  | AuthenticatedMcpIdentity
  | Promise<AuthenticatedMcpIdentity | undefined>
  | undefined;

export interface McpGatewayOptions {
  readonly app: DatagramApplicationPort;
  readonly authenticateIdentity: McpIdentityAuthenticator;
  readonly channelType?: ChannelTypeContractSelector;
}

interface SafeToolError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

type ActionReceipt = Awaited<ReturnType<DatagramApplicationPort['executeAction']>>;

const actionOutput = (receipt: ActionReceipt): ActionReceipt => ({
  action: receipt.action,
  operationId: receipt.operationId,
  ...(receipt.subject === undefined
    ? {}
    : { subject: { id: receipt.subject.id, kind: receipt.subject.kind } }),
});

const queryOutput = (handle: IssuedResultHandle): IssuedResultHandle => ({
  expiresAt: handle.expiresAt,
  id: handle.id,
  purpose: handle.purpose,
  view: {
    bindings: { ...handle.view.bindings },
    commands: [...handle.view.commands],
    kind: handle.view.kind,
    schemaVersion: handle.view.schemaVersion,
  },
});

const safeToolError = (error: unknown, operation: 'Action' | 'Query'): SafeToolError => ({
  error: {
    code: error instanceof DatagramError ? error.code : 'internal',
    message: `${operation} failed`,
  },
});

const toolResult = (output: ActionReceipt | IssuedResultHandle | SafeToolError, isError = false) => ({
  content: [{ text: JSON.stringify(output), type: 'text' as const }],
  isError,
  structuredContent: output,
});

export async function createMcpGateway({
  app,
  authenticateIdentity,
  channelType,
}: McpGatewayOptions): Promise<McpServer> {
  const authenticated = await authenticateIdentity();
  if (!authenticated) {
    throw new DatagramError('identity.unauthenticated', 'Authentication required', 401);
  }
  const identity = await app.verifyServiceIdentity(authenticated.actorId);
  const actorId = identity.actorId;
  const server = new McpServer(
    { name: 'prosto-datagram', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Datagram Actions return receipts only. Queries return opaque Result Handles and sanitized View metadata only.',
    },
  );

  for (const definition of app.actions.list(channelType)) {
    server.registerTool(
      definition.name,
      {
        annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (rawInput) => {
        try {
          const receipt = await app.executeAction(actorId, 'mcp', definition.name, rawInput);
          return toolResult(actionOutput(receipt));
        } catch (error) {
          return toolResult(safeToolError(error, 'Action'), true);
        }
      },
    );
  }

  for (const definition of app.queries.list(channelType)) {
    server.registerTool(
      definition.name,
      {
        annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
        description: `${definition.description} Returns an opaque Result Handle, never stored values.`,
        inputSchema: definition.inputSchema,
      },
      async (rawInput) => {
        try {
          const handle = await app.prepareQuery(actorId, 'mcp', definition.name, rawInput);
          return toolResult(queryOutput(handle));
        } catch (error) {
          return toolResult(safeToolError(error, 'Query'), true);
        }
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
      try {
        const handle = await app.composeResultHandle(actorId, composition);
        return toolResult(queryOutput(handle));
      } catch (error) {
        return toolResult(safeToolError(error, 'Query'), true);
      }
    },
  );

  return server;
}
