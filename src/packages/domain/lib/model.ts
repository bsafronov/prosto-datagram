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

export const operationOriginSchema = z.enum(['cli', 'http', 'mcp', 'agent', 'workflow', 'system']);
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

export const recordReferenceCardinalitySchema = z.enum(['one', 'many']);
export type RecordReferenceCardinality = z.infer<
  typeof recordReferenceCardinalitySchema
>;

export interface Person {
  readonly createdAt: string;
  readonly deactivatedAt?: string;
  readonly displayName: string;
  readonly id: string;
  readonly isOperator: boolean;
}

export interface Channel {
  readonly createdAt: string;
  readonly deletedAt?: string;
  readonly deletedBy?: string;
  readonly id: string;
  readonly ownerId: string;
  readonly purgedAt?: string;
  readonly purgedBy?: string;
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

export interface ChannelInvitation {
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly proposedRole: Exclude<ChannelRole, 'owner'>;
}

export interface DictionaryEntry {
  readonly channelId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly id: string;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly retiredAt?: string;
  readonly retiredBy?: string;
  readonly updatedAt?: string;
}

export interface TableField {
  readonly cardinality?: RecordReferenceCardinality;
  readonly channelId: string;
  readonly defaultValue?: JsonValue;
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly targetChannelId?: string;
  readonly tombstonedAt?: string;
  readonly tombstonedBy?: string;
  readonly type: TableFieldType;
  readonly unique: boolean;
  readonly version: number;
}

export interface TableRecord {
  readonly channelId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly id: string;
  readonly fieldVersions: Readonly<Record<string, number>>;
  readonly tombstonedAt?: string;
  readonly tombstonedBy?: string;
  readonly updatedAt?: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export interface TableViewFilter {
  readonly fieldId: string;
  readonly operator: 'contains' | 'equals' | 'greater-than' | 'is-empty' | 'less-than';
  readonly value?: JsonValue;
}

export interface TableViewSort {
  readonly direction: 'ascending' | 'descending';
  readonly fieldId: string;
}

export interface TableView {
  readonly channelId: string;
  readonly createdAt: string;
  readonly filters: readonly TableViewFilter[];
  readonly grouping: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly sorting: readonly TableViewSort[];
  readonly visibility: 'personal' | 'shared';
  readonly visibleFieldIds: readonly string[];
}

export interface ChartFilter {
  readonly field: string;
  readonly operator: 'contains' | 'equals' | 'greater-than' | 'is-empty' | 'less-than';
  readonly value?: JsonValue;
}

export interface ChartAggregation {
  readonly as: string;
  readonly field?: string;
  readonly operator: 'average' | 'count' | 'maximum' | 'minimum' | 'sum';
}

export interface ChartPresentation {
  readonly categoryField?: string;
  readonly series: readonly string[];
  readonly type: 'bar' | 'line' | 'pie';
}

export interface ChartDefinition {
  readonly aggregations: readonly ChartAggregation[];
  readonly channelId: string;
  readonly filters: readonly ChartFilter[];
  readonly grouping: readonly string[];
  readonly presentation: ChartPresentation;
  readonly sourceChannelId: string;
  readonly version: number;
}

export interface Message {
  readonly authorId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly recordReferences: readonly string[];
  readonly replyToMessageId?: string;
  readonly revisions: readonly MessageRevision[];
  readonly text: string;
  readonly tombstonedAt?: string;
  readonly tombstonedBy?: string;
}

export interface MessageRevision {
  readonly createdAt: string;
  readonly editorId: string;
  readonly id: string;
  readonly text: string;
}

export interface ChannelActivity {
  readonly actorId: string;
  readonly channelId: string;
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly operationId: string;
  readonly position: number;
}

export type PendingChannelActivity = Omit<ChannelActivity, 'position'>;

export type SubscriptionEvent =
  | {
      readonly activity: ChannelActivity;
      readonly id: string;
      readonly position: number;
      readonly type: 'activity';
    }
  | {
      readonly action: string;
      readonly actorId: string;
      readonly channelId?: string;
      readonly id: string;
      readonly occurredAt: string;
      readonly operationId: string;
      readonly position: number;
      readonly status: 'succeeded';
      readonly type: 'operation-result';
    };

export interface ChannelNavigation {
  readonly archivedAt?: string;
  readonly channelId: string;
  readonly lastReadActivityId?: string;
  readonly muted: boolean;
  readonly personId: string;
  readonly pinned: boolean;
  readonly position: number;
}

export interface ChannelGroup {
  readonly createdAt: string;
  readonly id: string;
  readonly name: string;
  readonly personId: string;
  readonly position: number;
}

export interface ChannelGroupEntry {
  readonly channelId: string;
  readonly groupId: string;
  readonly pinned: boolean;
  readonly position: number;
}

export interface ChannelListItem {
  readonly channel: Channel;
  readonly navigation: ChannelNavigation;
  readonly unreadCount: number;
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
  | {
      readonly deactivatedAt: string;
      readonly kind: 'person.deactivated';
      readonly personId: string;
    }
  | { readonly channel: Channel; readonly kind: 'channel.created' }
  | {
      readonly actorId: string;
      readonly channelId: string;
      readonly deletedAt: string;
      readonly kind: 'channel.deleted';
    }
  | {
      readonly actorId: string;
      readonly channelId: string;
      readonly kind: 'channel.restored';
      readonly restoredAt: string;
    }
  | {
      readonly actorId: string;
      readonly channelId: string;
      readonly kind: 'channel.purged';
      readonly purgedAt: string;
    }
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
  | {
      readonly channelId: string;
      readonly kind: 'membership.left';
      readonly personId: string;
    }
  | {
      readonly channelId: string;
      readonly kind: 'channel.ownership-transferred';
      readonly nextOwnerId: string;
      readonly previousOwnerId: string;
    }
  | {
      readonly invitation: ChannelInvitation;
      readonly kind: 'invitation.created';
    }
  | {
      readonly acceptedAt: string;
      readonly acceptedBy: string;
      readonly invitationId: string;
      readonly kind: 'invitation.accepted';
    }
  | { readonly group: ChannelGroup; readonly kind: 'channel-group.created' }
  | { readonly group: ChannelGroup; readonly kind: 'channel-group.updated' }
  | {
      readonly entry: ChannelGroupEntry;
      readonly kind: 'channel-group.entry-set';
    }
  | {
      readonly channelId: string;
      readonly groupId: string;
      readonly kind: 'channel-group.entry-removed';
    }
  | { readonly kind: 'channel-navigation.updated'; readonly navigation: ChannelNavigation }
  | { readonly entry: DictionaryEntry; readonly kind: 'dictionary.entry-created' }
  | {
      readonly entryId: string;
      readonly kind: 'dictionary.entry-renamed';
      readonly label: string;
      readonly normalizedLabel: string;
      readonly updatedAt: string;
    }
  | {
      readonly actorId: string;
      readonly entryId: string;
      readonly kind: 'dictionary.entry-retired';
      readonly retiredAt: string;
    }
  | {
      readonly entryId: string;
      readonly kind: 'dictionary.entry-restored';
      readonly restoredAt: string;
    }
  | { readonly field: TableField; readonly kind: 'table.field-added' }
  | {
      readonly expectedVersion: number;
      readonly field: TableField;
      readonly kind: 'table.field-updated';
      readonly previousField: TableField;
      readonly revertedOperationId?: string;
    }
  | {
      readonly channelId: string;
      readonly expectedVersion: number;
      readonly fieldId: string;
      readonly fieldKey: string;
      readonly kind: 'table.field-purged';
    }
  | {
      readonly channelId: string;
      readonly displayFieldId?: string;
      readonly kind: 'table.display-field-set';
    }
  | { readonly kind: 'table.record-created'; readonly record: TableRecord }
  | {
      readonly expectedVersions?: Readonly<Record<string, number>>;
      readonly kind: 'table.record-updated';
      readonly previousValues?: readonly {
        readonly existed: boolean;
        readonly key: string;
        readonly value?: JsonValue;
      }[];
      readonly recordId: string;
      readonly removedKeys?: readonly string[];
      readonly revertedOperationId?: string;
      readonly updatedAt: string;
      readonly values: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly actorId: string;
      readonly expectedUpdatedAt?: string | null;
      readonly kind: 'table.record-tombstoned';
      readonly recordId: string;
      readonly revertedOperationId?: string;
      readonly tombstonedAt: string;
    }
  | {
      readonly expectedTombstonedAt?: string;
      readonly kind: 'table.record-restored';
      readonly recordId: string;
      readonly revertedOperationId?: string;
      readonly restoredAt: string;
    }
  | { readonly kind: 'table.view-saved'; readonly view: TableView }
  | {
      readonly definition: ChartDefinition;
      readonly expectedVersion?: number;
      readonly kind: 'chart.definition-set';
    }
  | { readonly kind: 'discussion.message-posted'; readonly message: Message }
  | {
      readonly kind: 'discussion.message-edited';
      readonly messageId: string;
      readonly revision: MessageRevision;
    }
  | {
      readonly actorId: string;
      readonly kind: 'discussion.message-tombstoned';
      readonly messageId: string;
      readonly tombstonedAt: string;
    }
  | {
      readonly kind: 'discussion.message-restored';
      readonly messageId: string;
      readonly restoredBy: string;
    }
  | { readonly activity: PendingChannelActivity; readonly kind: 'activity.appended' };

export interface ActionReceipt {
  readonly action: string;
  readonly operationId: string;
  readonly subject?: {
    readonly id: string;
    readonly kind:
      | 'channel'
      | 'channel-group'
      | 'dictionary-entry'
      | 'field'
      | 'invitation'
      | 'message'
      | 'person'
      | 'record';
  };
}

const semanticIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);

export const viewBindingSchema = z
  .string()
  .regex(/^\$result(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/);

export const viewDefinitionSchema = z.strictObject({
  bindings: z.record(semanticIdentifierSchema, viewBindingSchema),
  commands: z.array(semanticIdentifierSchema),
  kind: semanticIdentifierSchema,
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
