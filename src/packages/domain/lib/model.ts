import * as z from 'zod/v4';

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.json();

export const channelRoleSchema = z.enum(['owner', 'admin', 'contributor', 'viewer']);
export type ChannelRole = z.infer<typeof channelRoleSchema>;

export const operationOriginSchema = z.enum([
  'cli',
  'http',
  'mcp',
  'agent',
  'workflow',
  'system',
]);
export type OperationOrigin = z.infer<typeof operationOriginSchema>;

export const tableFieldTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'date-time',
  'dictionary',
  'record-reference',
]);
export type TableFieldType = z.infer<typeof tableFieldTypeSchema>;

export interface Person {
  readonly createdAt: string;
  readonly displayName: string;
  readonly id: string;
  readonly isOperator: boolean;
}

export interface Channel {
  readonly createdAt: string;
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly typeId: string;
  readonly typeVersion: string;
  readonly updatedAt: string;
}

export interface ChannelMembership {
  readonly channelId: string;
  readonly personId: string;
  readonly role: ChannelRole;
}

export interface TableField {
  readonly channelId: string;
  readonly defaultValue?: JsonValue;
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: TableFieldType;
  readonly unique: boolean;
}

export interface TableRecord {
  readonly channelId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly id: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export interface Message {
  readonly authorId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly recordReferences: readonly string[];
  readonly text: string;
}

export interface ChannelActivity {
  readonly actorId: string;
  readonly channelId: string;
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly operationId: string;
}

export interface Operation {
  readonly action: string;
  readonly actorId: string;
  readonly changes: readonly DomainChange[];
  readonly channelId?: string;
  readonly id: string;
  readonly intent: string;
  readonly occurredAt: string;
  readonly origin: OperationOrigin;
  readonly result: JsonValue;
  readonly status: 'succeeded';
}

export type DomainChange =
  | { readonly kind: 'person.created'; readonly person: Person }
  | { readonly channel: Channel; readonly kind: 'channel.created' }
  | {
      readonly kind: 'membership.granted';
      readonly membership: ChannelMembership;
      readonly previousRole?: ChannelRole;
    }
  | {
      readonly channelId: string;
      readonly expectedRole: ChannelRole;
      readonly kind: 'membership.reverted';
      readonly personId: string;
      readonly revertedOperationId: string;
      readonly restoredRole?: ChannelRole;
    }
  | { readonly field: TableField; readonly kind: 'table.field-added' }
  | { readonly kind: 'table.record-created'; readonly record: TableRecord }
  | { readonly kind: 'discussion.message-posted'; readonly message: Message }
  | { readonly activity: ChannelActivity; readonly kind: 'activity.appended' };

export interface ActionReceipt {
  readonly action: string;
  readonly operationId: string;
  readonly subject?: {
    readonly id: string;
    readonly kind: 'channel' | 'field' | 'message' | 'person' | 'record';
  };
}

export const viewDefinitionSchema = z.object({
  bindings: z.record(z.string(), z.string()),
  commands: z.array(z.string()),
  kind: z.enum(['chart', 'discussion', 'table', 'value']),
  schemaVersion: z.literal('datagram/view@1'),
  title: z.string().min(1),
});
export type ViewDefinition = z.infer<typeof viewDefinitionSchema>;

export interface QueryResult {
  readonly data: JsonValue;
  readonly view: ViewDefinition;
}

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

export const nowIso = (): string => new Date().toISOString();
