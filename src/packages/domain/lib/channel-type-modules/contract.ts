import * as z from 'zod/v4';
import type {
  ActionReceipt,
  ChannelRole,
  ChartDefinition,
  JsonValue,
  Operation,
  QueryResult,
  TableView,
  ViewDefinition,
} from '../model';

export type ChannelContractAuthorization =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'message-author-or-admin' }
  | { readonly kind: 'operator' }
  | { readonly kind: 'channel-role'; readonly minimumRole: ChannelRole };

export type ChannelTypeOperation =
  | 'channel.create'
  | 'chart.create'
  | 'dictionary.entry.create'
  | 'table.display-field.set'
  | 'table.record.create'
  | 'table.view.create';

export interface ChannelActionCapabilities {
  readonly actorId: string;
  readonly changes: {
    readonly createChannel?: (title: string) => string;
    readonly createChart?: (input: {
      readonly handleId: string;
      readonly presentation: ChartDefinition['presentation'];
      readonly title: string;
      readonly typeVersion?: string;
    }) => Promise<ActionReceipt>;
    readonly createDictionaryEntry?: (label: string) => Promise<string>;
    readonly createTableRecord?: (values: Readonly<Record<string, JsonValue>>) => Promise<string>;
    readonly createTableView?: (
      input: Omit<TableView, 'channelId' | 'createdAt' | 'id' | 'ownerId'>,
    ) => Promise<string>;
    readonly setTableDisplayField?: (displayFieldId: string | null) => Promise<void>;
  };
  readonly commit: () => Promise<ActionReceipt>;
  readonly execute: (input: unknown) => Promise<ActionReceipt>;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
}

export interface ChannelQueryCapabilities {
  readonly actorId: string;
  readonly execute: (input: unknown) => Promise<QueryResult>;
  readonly read: (query: string, input: Readonly<Record<string, JsonValue>>) => Promise<QueryResult>;
  readonly role: ChannelRole;
}

export interface ChannelContract<TInput = unknown> {
  readonly allowedOperations: ChannelTypeOperation[];
  readonly authorization: ChannelContractAuthorization;
  readonly execute: (
    input: TInput,
    capabilities: ChannelActionCapabilities | ChannelQueryCapabilities,
  ) => Promise<unknown>;
  readonly inputSchema: z.ZodType<TInput>;
  readonly name: string;
}

export interface ChannelStateRule {
  readonly name: string;
  readonly validate: (contract: string, input: unknown) => void;
  readonly validateTransition?: (operation: Operation) => void;
}

export const contract = <TInput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  execute: ChannelContract<TInput>['execute'] = (input, capabilities) => capabilities.execute(input),
  authorization: ChannelContractAuthorization = { kind: 'channel-role', minimumRole: 'viewer' },
  allowedOperations: readonly ChannelTypeOperation[] = [],
): ChannelContract<TInput> => ({ allowedOperations: [...allowedOperations], authorization, execute, inputSchema, name });

export const channelIdSchema = z.string().min(1);

export const stateRule = (
  name: string,
  validate: ChannelStateRule['validate'],
  validateTransition?: ChannelStateRule['validateTransition'],
): ChannelStateRule => ({ name, validate, ...(validateTransition ? { validateTransition } : {}) });

export interface ChannelViewInput {
  readonly channelTitle?: string;
  readonly queryInput: unknown;
  readonly role: ChannelRole;
}

export interface ChannelViewDeclaration {
  readonly bindings: ViewDefinition['bindings'];
  readonly commandRoles?: Readonly<Record<string, ChannelRole>>;
  readonly commands: readonly string[];
  readonly kind: string;
  readonly title: string | ((input: ChannelViewInput) => string);
}

const roleRank: Readonly<Record<ChannelRole, number>> = {
  admin: 2,
  contributor: 1,
  owner: 3,
  viewer: 0,
};

export const produceOwnedView = (
  input: ChannelViewInput,
  declaration: ChannelViewDeclaration,
): ViewDefinition => ({
  bindings: { ...declaration.bindings },
  commands: declaration.commands.filter((command) =>
    roleRank[input.role] >= roleRank[declaration.commandRoles?.[command] ?? 'contributor'],
  ),
  kind: declaration.kind,
  schemaVersion: 'datagram/view@1',
  title: typeof declaration.title === 'function' ? declaration.title(input) : declaration.title,
});

export const channelCreateContract = contract('channel.create', z.object({
  title: z.string().trim().min(1).max(160),
  typeId: z.string().min(1),
  typeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
}), async (input, capabilities) => {
  if (!('changes' in capabilities)) return capabilities.execute(input);
  capabilities.changes.createChannel!(input.title);
  return capabilities.commit();
}, { kind: 'authenticated' }, ['channel.create']);
