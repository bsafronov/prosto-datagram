export type ApprovalReason = 'access-expanding' | 'bulk' | 'costly' | 'destructive';

export interface AgentApprovalRequest {
  readonly action: string;
  readonly reasons: readonly ApprovalReason[];
}

export type ApprovalRequester = (request: AgentApprovalRequest) => boolean | Promise<boolean>;

export interface AgentToolContract {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly kind: 'action' | 'query';
  readonly name: string;
}

/**
 * Zero-data connection implemented by a person-scoped MCP client or hosted API tool adapter.
 * Authentication, provider credentials, and subscription state stay with that adapter.
 */
export interface AgentToolConnection {
  callTool(name: string, input: unknown): Promise<unknown>;
  listContracts(): Promise<readonly AgentToolContract[]>;
}

export interface AgentActionReceipt {
  readonly action: string;
  readonly operationId: string;
  readonly subject?: { readonly id: string; readonly kind: string };
}

export interface AgentResultHandle {
  readonly expiresAt: string;
  readonly id: string;
  readonly purpose: string;
  readonly view: {
    readonly bindings: Readonly<Record<string, string>>;
    readonly commands: readonly string[];
    readonly kind: string;
    readonly schemaVersion: string;
  };
}

export interface AgentRuntime {
  discover(): Promise<readonly AgentToolContract[]>;
  executeAction(name: string, input: unknown): Promise<AgentActionReceipt>;
  executeQuery(name: string, input: unknown): Promise<AgentResultHandle>;
}

export interface AgentRuntimeOptions {
  readonly requestApproval?: ApprovalRequester;
  readonly tools: AgentToolConnection;
}

export interface CodexRuntimeOptions {
  /** Person-scoped MCP connection created and authenticated by Codex. */
  readonly mcp: AgentToolConnection;
  readonly requestApproval?: ApprovalRequester;
}

export interface ApiAgentRuntimeOptions extends AgentRuntimeOptions {}

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

const hasBulkInput = (input: unknown): boolean => {
  if (!isRecord(input)) return false;
  return Object.entries(input).some(
    ([key, value]) =>
      /^(entries|ids|items|operations|records|targets)$/.test(key) &&
      Array.isArray(value) &&
      value.length > 1,
  );
};

export function getApprovalRequirement(
  action: string,
  input: unknown,
): AgentApprovalRequest | undefined {
  const reasons: ApprovalReason[] = [];
  if (
    hasBulkInput(input) ||
    action === 'table.field.convert' ||
    /(^|\.)(bulk|import)(\.|$)/.test(action)
  ) {
    reasons.push('bulk');
  }
  if (
    action === 'channel.member.leave' ||
    action === 'operation.undo' ||
    /(^|\.)(deactivate|delete|purge|retire|tombstone)(\.|$)/.test(action)
  ) {
    reasons.push('destructive');
  }
  if (/(^|\.)(external|integration|publish|paid|costly)(\.|$)/.test(action)) {
    reasons.push('costly');
  }
  if (
    action === 'service.person.create' ||
    /(^|\.)(invitation\.(accept|create)|member\.grant|owner\.transfer|permission\.grant|share)(\.|$)/.test(
      action,
    )
  ) {
    reasons.push('access-expanding');
  }
  return reasons.length === 0 ? undefined : { action, reasons };
}

const structuredOutput = (value: unknown): Record<string, unknown> => {
  const envelope = isRecord(value) ? value : undefined;
  const output = envelope && isRecord(envelope.structuredContent) ? envelope.structuredContent : envelope;
  if (!output) throw new AgentRuntimeError('tool.invalid-output', 'Tool returned invalid output');
  if (isRecord(output.error)) {
    const code = typeof output.error.code === 'string' ? output.error.code : 'tool.failed';
    throw new AgentRuntimeError(code, 'Tool failed');
  }
  return output;
};

const actionReceipt = (value: unknown): AgentActionReceipt => {
  const output = structuredOutput(value);
  if (typeof output.action !== 'string' || typeof output.operationId !== 'string') {
    throw new AgentRuntimeError('tool.invalid-receipt', 'Action returned invalid receipt');
  }
  const subject = isRecord(output.subject) ? output.subject : undefined;
  return {
    action: output.action,
    operationId: output.operationId,
    ...(subject && typeof subject.id === 'string' && typeof subject.kind === 'string'
      ? { subject: { id: subject.id, kind: subject.kind } }
      : {}),
  };
};

const resultHandle = (value: unknown): AgentResultHandle => {
  const output = structuredOutput(value);
  const view = isRecord(output.view) ? output.view : undefined;
  const bindings = view && isRecord(view.bindings) ? view.bindings : undefined;
  const commands = view ? strings(view.commands) : undefined;
  if (
    typeof output.expiresAt !== 'string' ||
    typeof output.id !== 'string' ||
    typeof output.purpose !== 'string' ||
    !view ||
    !bindings ||
    !Object.values(bindings).every((item) => typeof item === 'string') ||
    !commands ||
    typeof view.kind !== 'string' ||
    typeof view.schemaVersion !== 'string'
  ) {
    throw new AgentRuntimeError('tool.invalid-handle', 'Query returned invalid Result Handle');
  }
  return {
    expiresAt: output.expiresAt,
    id: output.id,
    purpose: output.purpose,
    view: {
      bindings: { ...(bindings as Record<string, string>) },
      commands: [...commands],
      kind: view.kind,
      schemaVersion: view.schemaVersion,
    },
  };
};

class SharedAgentRuntime implements AgentRuntime {
  readonly #requestApproval: ApprovalRequester | undefined;
  readonly #tools: AgentToolConnection;
  #contracts: readonly AgentToolContract[] | undefined;

  constructor({ requestApproval, tools }: AgentRuntimeOptions) {
    this.#requestApproval = requestApproval;
    this.#tools = tools;
  }

  async discover(): Promise<readonly AgentToolContract[]> {
    const contracts = await this.#loadContracts();
    return contracts.map((contract) => ({ ...contract }));
  }

  async executeAction(name: string, input: unknown): Promise<AgentActionReceipt> {
    await this.#requireContract(name, 'action');
    const approval = getApprovalRequirement(name, input);
    if (approval && (!this.#requestApproval || !(await this.#requestApproval(approval)))) {
      throw new AgentRuntimeError('approval.required', 'Explicit approval required');
    }
    return actionReceipt(await this.#call(name, input, 'Action'));
  }

  async executeQuery(name: string, input: unknown): Promise<AgentResultHandle> {
    await this.#requireContract(name, 'query');
    return resultHandle(await this.#call(name, input, 'Query'));
  }

  async #call(name: string, input: unknown, kind: 'Action' | 'Query'): Promise<unknown> {
    try {
      return await this.#tools.callTool(name, input);
    } catch {
      throw new AgentRuntimeError('runtime.tool-failed', `${kind} failed`);
    }
  }

  async #loadContracts(): Promise<readonly AgentToolContract[]> {
    if (!this.#contracts) this.#contracts = await this.#tools.listContracts();
    return this.#contracts;
  }

  async #requireContract(name: string, kind: AgentToolContract['kind']): Promise<void> {
    const contract = (await this.#loadContracts()).find((candidate) => candidate.name === name);
    if (!contract || contract.kind !== kind) {
      throw new AgentRuntimeError('tool.not-found', `${kind === 'action' ? 'Action' : 'Query'} not found`);
    }
  }
}

export const createCodexRuntime = (options: CodexRuntimeOptions): AgentRuntime =>
  new SharedAgentRuntime({
    tools: options.mcp,
    ...(options.requestApproval === undefined
      ? {}
      : { requestApproval: options.requestApproval }),
  });

export const createApiAgentRuntime = (options: ApiAgentRuntimeOptions): AgentRuntime =>
  new SharedAgentRuntime(options);
