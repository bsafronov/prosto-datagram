import * as z from 'zod/v4';
import type {
  ActionReceipt,
  ChannelRole,
  ChartDefinition,
  JsonValue,
  Operation,
  QueryResult,
  ViewDefinition,
} from '../model';

export type ChannelContractAuthorization =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'operator' }
  | { readonly kind: 'channel-role'; readonly minimumRole: ChannelRole };

export interface ChannelActionCapabilities {
  readonly actorId: string;
  readonly changes: {
    readonly createChannel: (title: string) => string;
    readonly createDictionaryEntry: (label: string) => Promise<string>;
    readonly createTableRecord: (values: Readonly<Record<string, JsonValue>>) => Promise<string>;
    readonly setChartDefinition: (definition: Omit<ChartDefinition, 'channelId'>) => void;
    readonly setTableDisplayField: (displayFieldId: string | null) => void;
  };
  readonly commit: () => Promise<ActionReceipt>;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
}

export interface ChannelQueryCapabilities {
  readonly actorId: string;
  readonly read: (query: string, input: Readonly<Record<string, JsonValue>>) => Promise<QueryResult>;
  readonly role: ChannelRole;
}

export interface ChannelContract<TInput = unknown> {
  readonly authorization: ChannelContractAuthorization;
  readonly execute: (
    input: TInput,
    next: (input: TInput) => Promise<unknown>,
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
  execute: ChannelContract<TInput>['execute'] = (input, next) => next(input),
  authorization: ChannelContractAuthorization = { kind: 'channel-role', minimumRole: 'viewer' },
): ChannelContract<TInput> => ({ authorization, execute, inputSchema, name });

export const channelIdSchema = z.string().min(1);

export const stateRule = (
  name: string,
  validate: ChannelStateRule['validate'],
  validateTransition?: ChannelStateRule['validateTransition'],
): ChannelStateRule => ({ name, validate, ...(validateTransition ? { validateTransition } : {}) });

export interface ChannelViewInput {
  readonly bindings: ViewDefinition['bindings'];
  readonly role: ChannelRole;
  readonly title: string;
}

export interface ChannelViewDeclaration {
  readonly commandRoles?: Readonly<Record<string, ChannelRole>>;
  readonly commands: readonly string[];
  readonly kind: string;
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
  bindings: { ...input.bindings },
  commands: declaration.commands.filter((command) =>
    roleRank[input.role] >= roleRank[declaration.commandRoles?.[command] ?? 'contributor'],
  ),
  kind: declaration.kind,
  schemaVersion: 'datagram/view@1',
  title: input.title,
});

export const channelCreateContract = contract('channel.create', z.object({
  title: z.string().trim().min(1).max(160),
  typeId: z.string().min(1),
  typeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
}), undefined, { kind: 'authenticated' });
