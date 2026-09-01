import type {
  Channel,
  ChannelActivity,
  ChannelGroup,
  ChannelGroupEntry,
  ChannelInvitation,
  ChannelMembership,
  ChannelNavigation,
  ChartDefinition,
  DictionaryEntry,
  DomainChange,
  JsonValue,
  Message,
  Operation,
  Person,
  SubscriptionEvent,
  TableField,
  TableRecord,
  TableView,
} from '../../domain/model';
import { applyTableRecordUpdate, validatePostedMessage } from './domain-transitions';

export interface StoreState {
  readonly schemaVersion: 1;
  activitySequence: number;
  eventSequence: number;
  activities: ChannelActivity[];
  channelGroupEntries: ChannelGroupEntry[];
  channelGroups: ChannelGroup[];
  channels: Channel[];
  chartDefinitions: ChartDefinition[];
  dictionaryEntries: DictionaryEntry[];
  events: SubscriptionEvent[];
  invitations: ChannelInvitation[];
  memberships: ChannelMembership[];
  messages: Message[];
  navigation: ChannelNavigation[];
  operations: Operation[];
  persons: Person[];
  tableDisplayFields: Array<{ channelId: string; displayFieldId?: string }>;
  tableFields: TableField[];
  tableRecords: TableRecord[];
  tableViews: TableView[];
}

export const emptyState = (): StoreState => ({
  schemaVersion: 1,
  activitySequence: 0,
  eventSequence: 0,
  activities: [],
  channelGroupEntries: [],
  channelGroups: [],
  channels: [],
  chartDefinitions: [],
  dictionaryEntries: [],
  events: [],
  invitations: [],
  memberships: [],
  messages: [],
  navigation: [],
  operations: [],
  persons: [],
  tableDisplayFields: [],
  tableFields: [],
  tableRecords: [],
  tableViews: [],
});

export const parseState = (stateJson: string): StoreState => JSON.parse(stateJson) as StoreState;

export function one<T>(values: readonly T[], predicate: (value: T) => boolean): T | null {
  return values.find(predicate) ?? null;
}

export function replace<T>(values: T[], predicate: (value: T) => boolean, value: T): void {
  const index = values.findIndex(predicate);
  if (index === -1) throw new Error('Persisted value is unavailable');
  values[index] = value;
}

export function insert<T>(values: T[], predicate: (value: T) => boolean, value: T): void {
  if (values.some(predicate)) throw new Error('Persisted identity already exists');
  values.push(value);
}

export function remove<T>(values: T[], predicate: (value: T) => boolean): number {
  const before = values.length;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) values.splice(index, 1);
  }
  return before - values.length;
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function latestActivityPosition(state: StoreState, channelId: string): number {
  let latest = 0;
  for (const activity of state.activities) {
    if (activity.channelId === channelId) latest = Math.max(latest, activity.position);
  }
  return latest;
}

export function checkOwnerInvariant(state: StoreState): void {
  for (const channel of state.channels) {
    if (channel.purgedAt !== undefined) continue;
    const owners = state.memberships.filter(
      (membership) => membership.channelId === channel.id && membership.role === 'owner',
    );
    if (owners.length !== 1 || owners[0]!.personId !== channel.ownerId) {
      throw new Error('Each Channel must have exactly one Owner');
    }
  }
}

export function applyOperation(state: StoreState, operation: Operation): void {
  if (state.operations.some((candidate) => candidate.id === operation.id)) {
    throw new Error('Operation identity already exists');
  }
  for (const change of operation.changes) {
    if (change.kind !== 'activity.appended') applyChange(state, change);
  }
  checkOwnerInvariant(state);
  if (!state.persons.some((person) => person.id === operation.actorId)) {
    throw new Error('Operation actor is unavailable');
  }
  if (
    operation.channelId !== undefined &&
    !state.channels.some((channel) => channel.id === operation.channelId)
  ) {
    throw new Error('Operation Channel is unavailable');
  }
  state.operations.push(copy(operation));
  for (const change of operation.changes) {
    if (change.kind !== 'activity.appended') continue;
    applyChange(state, change);
    const activity = state.activities.at(-1)!;
    state.events.push({
      activity,
      id: activity.id,
      position: ++state.eventSequence,
      type: 'activity',
    });
  }
  state.events.push({
    action: operation.action,
    actorId: operation.actorId,
    ...(operation.channelId === undefined ? {} : { channelId: operation.channelId }),
    id: `operation-result:${operation.id}`,
    occurredAt: operation.occurredAt,
    operationId: operation.id,
    position: ++state.eventSequence,
    status: operation.status,
    type: 'operation-result',
  });
}

export function applyChange(state: StoreState, change: DomainChange): void {
  switch (change.kind) {
    case 'person.created':
      insert(state.persons, (person) => person.id === change.person.id, copy(change.person));
      return;
    case 'person.deactivated': {
      if (
        state.channels.some(
          (channel) => channel.ownerId === change.personId && channel.purgedAt === undefined,
        )
      ) {
        throw new Error('Channel ownership must be transferred before deactivation');
      }
      const person = one(state.persons, (candidate) => candidate.id === change.personId);
      if (!person || person.deactivatedAt !== undefined) throw new Error('Person is already deactivated');
      replace(state.persons, (candidate) => candidate.id === person.id, {
        ...person,
        deactivatedAt: change.deactivatedAt,
      });
      return;
    }
    case 'channel.created':
      if (!state.persons.some((person) => person.id === change.channel.ownerId)) {
        throw new Error('Channel Owner is unavailable');
      }
      insert(state.channels, (channel) => channel.id === change.channel.id, copy(change.channel));
      return;
    case 'channel.deleted': {
      const channel = one(state.channels, (candidate) => candidate.id === change.channelId);
      if (
        !channel ||
        channel.ownerId !== change.actorId ||
        channel.deletedAt !== undefined ||
        channel.purgedAt !== undefined
      ) {
        throw new Error('Channel cannot be deleted');
      }
      replace(state.channels, (candidate) => candidate.id === channel.id, {
        ...channel,
        deletedAt: change.deletedAt,
        deletedBy: change.actorId,
        updatedAt: change.deletedAt,
      });
      return;
    }
    case 'channel.restored': {
      const channel = one(state.channels, (candidate) => candidate.id === change.channelId);
      if (
        !channel ||
        channel.ownerId !== change.actorId ||
        channel.deletedAt === undefined ||
        channel.purgedAt !== undefined
      ) {
        throw new Error('Channel cannot be restored');
      }
      const { deletedAt: _deletedAt, deletedBy: _deletedBy, ...active } = channel;
      replace(state.channels, (candidate) => candidate.id === channel.id, {
        ...active,
        updatedAt: change.restoredAt,
      });
      return;
    }
    case 'channel.purged': {
      const channel = one(state.channels, (candidate) => candidate.id === change.channelId);
      if (
        !channel ||
        channel.ownerId !== change.actorId ||
        channel.deletedAt === undefined ||
        channel.purgedAt !== undefined
      ) {
        throw new Error('Channel cannot be purged');
      }
      const messageIds = new Set(
        state.messages.filter((message) => message.channelId === channel.id).map((message) => message.id),
      );
      remove(state.channelGroupEntries, (entry) => entry.channelId === channel.id);
      remove(state.navigation, (navigation) => navigation.channelId === channel.id);
      remove(state.tableDisplayFields, (setting) => setting.channelId === channel.id);
      remove(state.tableViews, (view) => view.channelId === channel.id);
      remove(state.chartDefinitions, (definition) => definition.channelId === channel.id);
      remove(state.dictionaryEntries, (entry) => entry.channelId === channel.id);
      remove(state.tableRecords, (record) => record.channelId === channel.id);
      remove(state.tableFields, (field) => field.channelId === channel.id);
      remove(state.messages, (message) => messageIds.has(message.id));
      remove(state.invitations, (invitation) => invitation.channelId === channel.id);
      remove(state.events, (event) =>
        event.type === 'activity'
          ? event.activity.channelId === channel.id
          : event.channelId === channel.id,
      );
      remove(state.activities, (activity) => activity.channelId === channel.id);
      remove(state.operations, (operation) => operation.channelId === channel.id);
      remove(state.memberships, (membership) => membership.channelId === channel.id);
      replace(state.channels, (candidate) => candidate.id === channel.id, {
        ...channel,
        purgedAt: change.purgedAt,
        purgedBy: change.actorId,
        title: '[purged]',
        updatedAt: change.purgedAt,
      });
      return;
    }
    case 'membership.granted': {
      const channel = one(state.channels, (candidate) => candidate.id === change.membership.channelId);
      if (!channel || !state.persons.some((person) => person.id === change.membership.personId)) {
        throw new Error('Membership subject is unavailable');
      }
      if (
        (change.membership.role === 'owner' && channel.ownerId !== change.membership.personId) ||
        (change.membership.role !== 'owner' && channel.ownerId === change.membership.personId)
      ) {
        throw new Error(
          change.membership.role === 'owner'
            ? 'Ownership requires an ownership transfer'
            : 'Channel Owner cannot receive a non-owner role',
        );
      }
      const current = one(
        state.memberships,
        (membership) =>
          membership.channelId === change.membership.channelId &&
          membership.personId === change.membership.personId,
      );
      if (current) {
        replace(state.memberships, (membership) => membership === current, copy(change.membership));
      } else {
        state.memberships.push(copy(change.membership));
      }
      return;
    }
    case 'membership.reverted': {
      if (change.expectedRole === 'owner') throw new Error('Channel Owner membership cannot be reverted');
      const membership = one(
        state.memberships,
        (candidate) =>
          candidate.channelId === change.channelId &&
          candidate.personId === change.personId &&
          candidate.role === change.expectedRole,
      );
      if (!membership) throw new Error('Membership changed after original Operation');
      if (change.restoredRole) {
        replace(state.memberships, (candidate) => candidate === membership, {
          ...membership,
          role: change.restoredRole,
        });
      } else {
        remove(state.memberships, (candidate) => candidate === membership);
      }
      return;
    }
    case 'membership.left': {
      const removed = remove(
        state.memberships,
        (membership) =>
          membership.channelId === change.channelId &&
          membership.personId === change.personId &&
          membership.role !== 'owner',
      );
      if (removed !== 1) throw new Error('Channel Owner cannot leave');
      return;
    }
    case 'channel.ownership-transferred': {
      const channel = one(
        state.channels,
        (candidate) => candidate.id === change.channelId && candidate.ownerId === change.previousOwnerId,
      );
      const previous = one(
        state.memberships,
        (membership) =>
          membership.channelId === change.channelId &&
          membership.personId === change.previousOwnerId &&
          membership.role === 'owner',
      );
      if (!channel) throw new Error('Channel ownership changed');
      if (!previous) throw new Error('Previous Owner membership changed');
      replace(state.channels, (candidate) => candidate === channel, {
        ...channel,
        ownerId: change.nextOwnerId,
      });
      replace(state.memberships, (membership) => membership === previous, {
        ...previous,
        role: 'admin',
      });
      const next = one(
        state.memberships,
        (membership) =>
          membership.channelId === change.channelId && membership.personId === change.nextOwnerId,
      );
      if (next) {
        replace(state.memberships, (membership) => membership === next, { ...next, role: 'owner' });
      } else {
        state.memberships.push({
          channelId: change.channelId,
          personId: change.nextOwnerId,
          role: 'owner',
        });
      }
      return;
    }
    case 'invitation.created':
      insert(state.invitations, (invitation) => invitation.id === change.invitation.id, copy(change.invitation));
      return;
    case 'invitation.accepted': {
      const invitation = one(state.invitations, (candidate) => candidate.id === change.invitationId);
      if (!invitation || invitation.acceptedAt !== undefined) throw new Error('Invitation is already accepted');
      replace(state.invitations, (candidate) => candidate === invitation, {
        ...invitation,
        acceptedAt: change.acceptedAt,
        acceptedBy: change.acceptedBy,
      });
      return;
    }
    case 'channel-group.created':
      insert(state.channelGroups, (group) => group.id === change.group.id, copy(change.group));
      return;
    case 'channel-group.updated': {
      const group = one(
        state.channelGroups,
        (candidate) => candidate.id === change.group.id && candidate.personId === change.group.personId,
      );
      if (!group) throw new Error('Channel Group changed');
      replace(state.channelGroups, (candidate) => candidate === group, copy(change.group));
      return;
    }
    case 'channel-group.entry-set': {
      const current = one(
        state.channelGroupEntries,
        (entry) => entry.groupId === change.entry.groupId && entry.channelId === change.entry.channelId,
      );
      if (current) replace(state.channelGroupEntries, (entry) => entry === current, copy(change.entry));
      else state.channelGroupEntries.push(copy(change.entry));
      return;
    }
    case 'channel-group.entry-removed':
      if (
        remove(
          state.channelGroupEntries,
          (entry) => entry.groupId === change.groupId && entry.channelId === change.channelId,
        ) !== 1
      ) {
        throw new Error('Channel is not in Channel Group');
      }
      return;
    case 'channel-navigation.updated': {
      const current = one(
        state.navigation,
        (navigation) =>
          navigation.channelId === change.navigation.channelId &&
          navigation.personId === change.navigation.personId,
      );
      if (current) replace(state.navigation, (navigation) => navigation === current, copy(change.navigation));
      else state.navigation.push(copy(change.navigation));
      return;
    }
    case 'dictionary.entry-created':
      if (
        state.dictionaryEntries.some(
          (entry) =>
            entry.id === change.entry.id ||
            (entry.channelId === change.entry.channelId &&
              entry.retiredAt === undefined &&
              entry.normalizedLabel === change.entry.normalizedLabel),
        )
      ) {
        throw new Error('Dictionary Entry already exists');
      }
      state.dictionaryEntries.push(copy(change.entry));
      return;
    case 'dictionary.entry-renamed': {
      const entry = one(state.dictionaryEntries, (candidate) => candidate.id === change.entryId);
      if (!entry) throw new Error('Dictionary Entry is unavailable');
      if (
        state.dictionaryEntries.some(
          (candidate) =>
            candidate.id !== entry.id &&
            candidate.channelId === entry.channelId &&
            candidate.retiredAt === undefined &&
            candidate.normalizedLabel === change.normalizedLabel,
        )
      ) {
        throw new Error('Dictionary Entry already exists');
      }
      replace(state.dictionaryEntries, (candidate) => candidate === entry, {
        ...entry,
        label: change.label,
        normalizedLabel: change.normalizedLabel,
        updatedAt: change.updatedAt,
      });
      return;
    }
    case 'dictionary.entry-retired': {
      const entry = one(state.dictionaryEntries, (candidate) => candidate.id === change.entryId);
      if (!entry || entry.retiredAt !== undefined) throw new Error('Dictionary Entry is already retired');
      replace(state.dictionaryEntries, (candidate) => candidate === entry, {
        ...entry,
        retiredAt: change.retiredAt,
        retiredBy: change.actorId,
        updatedAt: change.retiredAt,
      });
      return;
    }
    case 'dictionary.entry-restored': {
      const entry = one(state.dictionaryEntries, (candidate) => candidate.id === change.entryId);
      if (!entry || entry.retiredAt === undefined) throw new Error('Dictionary Entry is not retired');
      if (state.dictionaryEntries.some((candidate) =>
        candidate.id !== entry.id &&
        candidate.channelId === entry.channelId &&
        candidate.retiredAt === undefined &&
        candidate.normalizedLabel === entry.normalizedLabel
      )) throw new Error('Dictionary Entry already exists');
      const { retiredAt: _retiredAt, retiredBy: _retiredBy, ...active } = entry;
      replace(state.dictionaryEntries, (candidate) => candidate === entry, {
        ...active,
        updatedAt: change.restoredAt,
      });
      return;
    }
    case 'table.field-added':
      if (
        state.tableFields.some(
          (field) =>
            field.id === change.field.id ||
            (field.channelId === change.field.channelId && field.key === change.field.key),
        )
      ) {
        throw new Error('Table Field already exists');
      }
      state.tableFields.push(copy(change.field));
      return;
    case 'table.field-updated': {
      const field = one(
        state.tableFields,
        (candidate) => candidate.id === change.field.id && candidate.version === change.expectedVersion,
      );
      if (!field) throw new Error('Table Field changed after observation');
      replace(state.tableFields, (candidate) => candidate === field, copy(change.field));
      return;
    }
    case 'table.field-purged': {
      const field = one(
        state.tableFields,
        (candidate) =>
          candidate.id === change.fieldId &&
          candidate.channelId === change.channelId &&
          candidate.version === change.expectedVersion &&
          candidate.tombstonedAt !== undefined,
      );
      if (!field) throw new Error('Table Field changed after observation');
      remove(state.tableFields, (candidate) => candidate === field);
      state.tableRecords = state.tableRecords.map((record) => {
        if (record.channelId !== change.channelId) return record;
        const values = { ...record.values };
        const fieldVersions = { ...record.fieldVersions };
        delete values[change.fieldKey];
        delete fieldVersions[change.fieldKey];
        return { ...record, fieldVersions, values };
      });
      state.operations = state.operations.map((operation) => {
        if (operation.channelId !== change.channelId) return operation;
        const changes = copy(operation.changes) as DomainChange[];
        for (const historical of changes) {
          if (historical.kind === 'table.record-created') {
            delete (historical.record.values as Record<string, JsonValue>)[change.fieldKey];
            delete (historical.record.fieldVersions as Record<string, number>)[change.fieldKey];
          }
          if (historical.kind === 'table.record-updated') {
            delete (historical.values as Record<string, JsonValue>)[change.fieldKey];
            if (historical.previousValues) {
              (historical as { previousValues?: typeof historical.previousValues }).previousValues =
                historical.previousValues.filter((entry) => entry.key !== change.fieldKey);
            }
          }
        }
        return { ...operation, changes };
      });
      return;
    }
    case 'table.display-field-set': {
      const current = one(state.tableDisplayFields, (setting) => setting.channelId === change.channelId);
      const setting = {
        channelId: change.channelId,
        ...(change.displayFieldId === undefined ? {} : { displayFieldId: change.displayFieldId }),
      };
      if (current) replace(state.tableDisplayFields, (candidate) => candidate === current, setting);
      else state.tableDisplayFields.push(setting);
      return;
    }
    case 'table.record-created':
      insert(state.tableRecords, (record) => record.id === change.record.id, copy(change.record));
      return;
    case 'table.record-updated': {
      const record = one(state.tableRecords, (candidate) => candidate.id === change.recordId);
      if (!record) throw new Error('Table Record is unavailable');
      replace(
        state.tableRecords,
        (candidate) => candidate === record,
        applyTableRecordUpdate(record, change),
      );
      return;
    }
    case 'table.record-tombstoned': {
      const record = one(state.tableRecords, (candidate) => candidate.id === change.recordId);
      const expectedMatches =
        change.expectedUpdatedAt === undefined ||
        (change.expectedUpdatedAt === null
          ? record?.updatedAt === undefined
          : record?.updatedAt === change.expectedUpdatedAt);
      if (!record || record.tombstonedAt !== undefined || !expectedMatches) {
        throw new Error('Table Record is already tombstoned');
      }
      replace(state.tableRecords, (candidate) => candidate === record, {
        ...record,
        tombstonedAt: change.tombstonedAt,
        tombstonedBy: change.actorId,
        updatedAt: change.tombstonedAt,
      });
      return;
    }
    case 'table.record-restored': {
      const record = one(state.tableRecords, (candidate) => candidate.id === change.recordId);
      if (
        !record ||
        record.tombstonedAt === undefined ||
        (change.expectedTombstonedAt !== undefined &&
          record.tombstonedAt !== change.expectedTombstonedAt)
      ) {
        throw new Error('Table Record is not tombstoned');
      }
      const { tombstonedAt: _tombstonedAt, tombstonedBy: _tombstonedBy, ...active } = record;
      replace(state.tableRecords, (candidate) => candidate === record, {
        ...active,
        updatedAt: change.restoredAt,
      });
      return;
    }
    case 'table.view-saved': {
      const current = one(state.tableViews, (view) => view.id === change.view.id);
      if (current) replace(state.tableViews, (view) => view === current, copy(change.view));
      else state.tableViews.push(copy(change.view));
      return;
    }
    case 'chart.definition-set': {
      const current = one(
        state.chartDefinitions,
        (definition) => definition.channelId === change.definition.channelId,
      );
      if (change.expectedVersion === undefined) {
        if (current) throw new Error('Chart definition already exists');
        state.chartDefinitions.push(copy(change.definition));
        return;
      }
      if (!current || current.version !== change.expectedVersion) {
        throw new Error('Chart definition changed after observation');
      }
      replace(state.chartDefinitions, (definition) => definition === current, copy(change.definition));
      return;
    }
    case 'discussion.message-posted': {
      const revision = change.message.revisions[0]!;
      const target = one(state.messages, (message) => message.id === change.message.replyToMessageId);
      validatePostedMessage(change.message, target?.channelId);
      if (
        state.messages.some(
          (message) =>
            message.id === change.message.id ||
            message.revisions.some((candidate) => candidate.id === revision.id),
        )
      ) {
        throw new Error('Message identity already exists');
      }
      state.messages.push(copy(change.message));
      return;
    }
    case 'discussion.message-edited': {
      const message = one(state.messages, (candidate) => candidate.id === change.messageId);
      if (!message || message.tombstonedAt !== undefined) throw new Error('Message cannot be edited');
      if (state.messages.some((candidate) => candidate.revisions.some((revision) => revision.id === change.revision.id))) {
        throw new Error('Message revision identity already exists');
      }
      replace(state.messages, (candidate) => candidate === message, {
        ...message,
        revisions: [...message.revisions, copy(change.revision)],
        text: change.revision.text,
      });
      return;
    }
    case 'discussion.message-tombstoned': {
      const message = one(state.messages, (candidate) => candidate.id === change.messageId);
      if (!message || message.tombstonedAt !== undefined) throw new Error('Message is already tombstoned');
      replace(state.messages, (candidate) => candidate === message, {
        ...message,
        tombstonedAt: change.tombstonedAt,
        tombstonedBy: change.actorId,
      });
      return;
    }
    case 'discussion.message-restored': {
      const message = one(state.messages, (candidate) => candidate.id === change.messageId);
      if (!message || message.tombstonedAt === undefined) throw new Error('Message is not tombstoned');
      const { tombstonedAt: _tombstonedAt, tombstonedBy: _tombstonedBy, ...active } = message;
      replace(state.messages, (candidate) => candidate === message, active);
      return;
    }
    case 'activity.appended': {
      if (state.activities.some((activity) => activity.id === change.activity.id)) {
        throw new Error('Channel Activity identity already exists');
      }
      if (!state.operations.some((operation) => operation.id === change.activity.operationId)) {
        throw new Error('Channel Activity Operation is unavailable');
      }
      if (!state.persons.some((person) => person.id === change.activity.actorId)) {
        throw new Error('Channel Activity actor is unavailable');
      }
      const activity: ChannelActivity = {
        ...copy(change.activity),
        position: ++state.activitySequence,
      };
      state.activities.push(activity);
      const channel = one(state.channels, (candidate) => candidate.id === activity.channelId);
      if (!channel) throw new Error('Channel Activity Channel is unavailable');
      replace(state.channels, (candidate) => candidate === channel, {
        ...channel,
        updatedAt: activity.occurredAt,
      });
      state.navigation = state.navigation.map((navigation) => {
        if (
          navigation.channelId !== activity.channelId ||
          navigation.archivedAt === undefined ||
          navigation.muted
        ) {
          return navigation;
        }
        const { archivedAt: _archivedAt, ...active } = navigation;
        return active;
      });
      return;
    }
  }
}
