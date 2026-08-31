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
  readonly deactivatedAt?: string;
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
}

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
      readonly kind: 'channel.ownership-transferred';
      readonly nextOwnerId: string;
      readonly previousOwnerId: string;
    }
  | { readonly invitation: ChannelInvitation; readonly kind: 'invitation.created' }
  | {
      readonly acceptedAt: string;
      readonly acceptedBy: string;
      readonly invitationId: string;
      readonly kind: 'invitation.accepted';
    }
  | { readonly group: ChannelGroup; readonly kind: 'channel-group.created' }
  | { readonly group: ChannelGroup; readonly kind: 'channel-group.updated' }
  | { readonly entry: ChannelGroupEntry; readonly kind: 'channel-group.entry-set' }
  | {
      readonly channelId: string;
      readonly groupId: string;
      readonly kind: 'channel-group.entry-removed';
    }
  | { readonly kind: 'channel-navigation.updated'; readonly navigation: ChannelNavigation }
  | { readonly field: TableField; readonly kind: 'table.field-added' }
  | {
      readonly channelId: string;
      readonly displayFieldId?: string;
      readonly kind: 'table.display-field-set';
    }
  | { readonly kind: 'table.record-created'; readonly record: TableRecord }
  | {
      readonly kind: 'table.record-updated';
      readonly recordId: string;
      readonly updatedAt: string;
      readonly values: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly actorId: string;
      readonly kind: 'table.record-tombstoned';
      readonly recordId: string;
      readonly tombstonedAt: string;
    }
  | {
      readonly kind: 'table.record-restored';
      readonly recordId: string;
      readonly restoredAt: string;
    }
  | { readonly kind: 'table.view-saved'; readonly view: TableView }
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
  | { readonly activity: ChannelActivity; readonly kind: 'activity.appended' };

export interface ActionReceipt {
  readonly action: string;
  readonly operationId: string;
  readonly subject?: {
    readonly id: string;
    readonly kind:
      | 'channel'
      | 'channel-group'
      | 'field'
      | 'invitation'
      | 'message'
      | 'person'
      | 'record';
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
