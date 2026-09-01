import * as z from 'zod/v4';
import type {
  ActionReceipt,
  Channel,
  ChannelRole,
  ChartDefinition,
  DictionaryEntry,
  JsonValue,
  Message,
  Operation,
  QueryResult,
  TableField,
  TableRecord,
  TableView,
  ViewDefinition,
} from '../model';

export type ChannelContractAuthorization =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'message-author-or-admin' }
  | { readonly kind: 'operator' }
  | { readonly kind: 'channel-role'; readonly minimumRole: ChannelRole };

export type ChannelTypeOperation =
  | 'addTableField'
  | 'cancel'
  | 'createChannel'
  | 'createChart'
  | 'createDictionaryEntry'
  | 'createTableRecord'
  | 'createTableView'
  | 'editDiscussionMessage'
  | 'postDiscussionMessage'
  | 'purgeTableField'
  | 'recordChartEvent'
  | 'renameDictionaryEntry'
  | 'restoreDictionaryEntry'
  | 'restoreDiscussionMessage'
  | 'restoreTableRecord'
  | 'retireDictionaryEntry'
  | 'setChartDefinition'
  | 'setTableDisplayField'
  | 'tombstoneDiscussionMessage'
  | 'tombstoneTableRecord'
  | 'updateTableField'
  | 'updateTableRecord';

export interface ChannelTypeStatePort {
  readonly acceptsTableFieldValue: (field: TableField, value: JsonValue) => Promise<boolean>;
  readonly channel: Channel;
  readonly chartDefinition: () => Promise<ChartDefinition | null>;
  readonly validateChartDefinition: (definition: ChartDefinition) => Promise<void>;
  readonly dictionaryEntries: () => Promise<readonly DictionaryEntry[]>;
  readonly dictionaryEntry: (entryId: string) => Promise<DictionaryEntry | null>;
  readonly displayFieldId: () => Promise<string | null>;
  readonly message: (messageId: string) => Promise<Message | null>;
  readonly messages: () => Promise<readonly Message[]>;
  readonly resolveRecordReference: (recordId: string) => Promise<JsonValue>;
  readonly resolveTableValues: (
    fields: readonly TableField[],
    values: Readonly<Record<string, JsonValue>>,
  ) => Promise<Readonly<Record<string, JsonValue>>>;
  readonly validateTableFieldTarget: (field: TableField) => Promise<void>;
  readonly validateTableRecordValues: (
    fields: readonly TableField[],
    records: readonly TableRecord[],
    values: Readonly<Record<string, JsonValue>>,
    currentRecordId?: string,
    applyDefaults?: boolean,
    changedKeys?: readonly string[],
  ) => Promise<Readonly<Record<string, JsonValue>>>;
  readonly tableFields: () => Promise<readonly TableField[]>;
  readonly tableRecord: (recordId: string) => Promise<TableRecord | null>;
  readonly tableRecords: () => Promise<readonly TableRecord[]>;
  readonly tableViews: () => Promise<readonly TableView[]>;
}

export interface ChannelActionCapabilities {
  readonly actorId: string;
  readonly state?: ChannelTypeStatePort;
  readonly changes: {
    readonly createChannel?: (title: string) => string;
    readonly createChart?: () => Promise<void>;
    readonly setChartDefinition?: (definition: ChartDefinition, expectedVersion?: number) => Promise<void>;
    readonly recordChartEvent?: (kind: 'chart.insight-produced' | 'chart.report-produced' | 'chart.threshold-crossed') => Promise<void>;
    readonly createDictionaryEntry?: (label: string) => Promise<string>;
    readonly renameDictionaryEntry?: (input: {
      readonly entryId: string;
      readonly label: string;
      readonly normalizedLabel: string;
      readonly updatedAt: string;
    }) => Promise<void>;
    readonly restoreDictionaryEntry?: (entryId: string, restoredAt: string) => Promise<void>;
    readonly retireDictionaryEntry?: (entryId: string, retiredAt: string) => Promise<void>;
    readonly editDiscussionMessage?: (messageId: string, text: string) => Promise<void>;
    readonly postDiscussionMessage?: (input: {
      readonly recordReferences: readonly string[];
      readonly replyToMessageId?: string;
      readonly text: string;
    }) => Promise<string>;
    readonly restoreDiscussionMessage?: (messageId: string) => Promise<void>;
    readonly tombstoneDiscussionMessage?: (messageId: string) => Promise<void>;
    readonly createTableRecord?: (values: Readonly<Record<string, JsonValue>>) => Promise<string>;
    readonly createTableView?: (
      input: Omit<TableView, 'channelId' | 'createdAt' | 'id' | 'ownerId'>,
    ) => Promise<string>;
    readonly setTableDisplayField?: (displayFieldId: string | null) => Promise<void>;
    readonly addTableField?: (field: TableField) => Promise<void>;
    readonly purgeTableField?: (field: TableField) => Promise<void>;
    readonly updateTableField?: (field: TableField, previousField: TableField) => Promise<void>;
    readonly updateTableRecord?: (input: {
      readonly expectedVersions?: Readonly<Record<string, number>>;
      readonly previousValues?: readonly { readonly existed: boolean; readonly key: string; readonly value?: JsonValue }[];
      readonly recordId: string;
      readonly removedKeys?: readonly string[];
      readonly values: Readonly<Record<string, JsonValue>>;
    }) => Promise<void>;
    readonly restoreTableRecord?: (recordId: string, expectedTombstonedAt?: string) => Promise<void>;
    readonly tombstoneTableRecord?: (recordId: string, expectedUpdatedAt?: string | null) => Promise<void>;
  };
  readonly commit: () => Promise<ActionReceipt>;
  readonly cancel?: (subject: ActionReceipt['subject']) => Promise<ActionReceipt>;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
}

export interface ChannelQueryCapabilities {
  readonly actorId: string;
  readonly read: (query: string, input: Readonly<Record<string, JsonValue>>) => Promise<QueryResult>;
  readonly readSourceTable: (channelId: string) => Promise<QueryResult>;
  readonly role?: ChannelRole;
  readonly state?: ChannelTypeStatePort;
  readonly transform: (result: QueryResult, transform:
    | { readonly aggregations: readonly { readonly as: string; readonly field?: string; readonly operator: 'average' | 'count' | 'maximum' | 'minimum' | 'sum' }[]; readonly kind: 'aggregate' }
    | { readonly fields: readonly string[]; readonly kind: 'group' }
    | { readonly filters: readonly { readonly field: string; readonly operator: 'contains' | 'equals' | 'greater-than' | 'is-empty' | 'less-than'; readonly value?: JsonValue }[]; readonly kind: 'filter' }
  ) => QueryResult;
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
  execute: ChannelContract<TInput>['execute'],
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
  readonly resultTitle?: string;
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
  if (!('changes' in capabilities)) throw new Error('Channel creation needs Action capabilities');
  capabilities.changes.createChannel!(input.title);
  return capabilities.commit();
}, { kind: 'authenticated' }, ['createChannel']);
