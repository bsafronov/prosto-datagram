import { SQL } from 'bun';

import type { DatagramStore } from '../../application/store';
import {
  applyChange,
  checkOwnerInvariant,
  copy,
  emptyState,
  insert,
  latestActivityPosition,
  one,
  parseState,
  type StoreState,
} from '../../application/transitions';
import type {
  Channel,
  ChannelActivity,
  ChannelGroup,
  ChannelGroupEntry,
  ChannelInvitation,
  ChannelListItem,
  ChannelMembership,
  ChannelNavigation,
  ChartDefinition,
  DictionaryEntry,
  Message,
  Operation,
  Person,
  SubscriptionEvent,
  TableField,
  TableRecord,
  TableView,
} from '../../domain/model';
import { newId, nowIso } from '../../domain/model';

interface StateRow {
  readonly state_json: string;
}

export interface PostgresStoreOptions {
  readonly connectionString: string;
  readonly serviceKey?: string;
}

export interface DeploymentOperatorOptions {
  readonly displayName?: string;
  readonly id?: string;
}

export class PostgresStore implements DatagramStore {
  readonly #client: SQL;
  readonly #serviceKey: string;
  #initialized = false;

  constructor(options: PostgresStoreOptions | string) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.#client = new SQL(normalized.connectionString);
    this.#serviceKey = normalized.serviceKey ?? 'default';
  }

  async initialize(): Promise<void> {
    await this.#client`
      CREATE TABLE IF NOT EXISTS datagram_store_state (
        service_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
    await this.#client`
      INSERT INTO datagram_store_state (service_key, state_json)
      VALUES (${this.#serviceKey}, ${JSON.stringify(emptyState())})
      ON CONFLICT (service_key) DO NOTHING
    `;
    this.#initialized = true;
  }

  async #state(): Promise<StoreState> {
    if (!this.#initialized) throw new Error('PostgreSQL Store is not initialized');
    const rows = await this.#client.unsafe<StateRow[]>(
      'SELECT state_json FROM datagram_store_state WHERE service_key = $1',
      [this.#serviceKey],
    );
    const row = rows[0];
    if (!row) throw new Error('PostgreSQL Store state is unavailable');
    return parseState(row.state_json);
  }

  async #bootstrapOperator(options: DeploymentOperatorOptions): Promise<Person> {
    if (!this.#initialized) throw new Error('PostgreSQL Store is not initialized');
    return this.#client.begin(async (sql) => {
      const rows = await sql.unsafe<StateRow[]>(
        'SELECT state_json FROM datagram_store_state WHERE service_key = $1 FOR UPDATE',
        [this.#serviceKey],
      );
      const row = rows[0];
      if (!row) throw new Error('PostgreSQL Store state is unavailable');
      const state = parseState(row.state_json);
      const existing = state.persons
        .filter((person) => person.isOperator && person.deactivatedAt === undefined)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (existing) return existing;
      const person: Person = {
        createdAt: nowIso(),
        displayName: options.displayName ?? 'Deployment Operator',
        id: options.id ?? newId('person'),
        isOperator: true,
      };
      insert(state.persons, (candidate) => candidate.id === person.id, person);
      await sql.unsafe(
        `UPDATE datagram_store_state
         SET state_json = $1, revision = revision + 1
         WHERE service_key = $2`,
        [JSON.stringify(state), this.#serviceKey],
      );
      return person;
    });
  }

  ensureDeploymentOperator(options: DeploymentOperatorOptions = {}): Promise<Person> {
    return this.#bootstrapOperator(options);
  }

  ensureLocalOwner(displayName = 'Local Owner'): Promise<Person> {
    return this.#bootstrapOperator({ displayName });
  }

  async commit(operation: Operation): Promise<void> {
    if (!this.#initialized) throw new Error('PostgreSQL Store is not initialized');
    await this.#client.begin(async (sql) => {
      const rows = await sql.unsafe<StateRow[]>(
        'SELECT state_json FROM datagram_store_state WHERE service_key = $1 FOR UPDATE',
        [this.#serviceKey],
      );
      const row = rows[0];
      if (!row) throw new Error('PostgreSQL Store state is unavailable');
      const state = parseState(row.state_json);
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
      await sql.unsafe(
        `UPDATE datagram_store_state
         SET state_json = $1, revision = revision + 1
         WHERE service_key = $2`,
        [JSON.stringify(state), this.#serviceKey],
      );
    });
  }

  async getActivity(activityId: string): Promise<ChannelActivity | null> {
    return one((await this.#state()).activities, (activity) => activity.id === activityId);
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    return one((await this.#state()).channels, (channel) => channel.id === channelId);
  }

  async getChannelGroup(groupId: string): Promise<ChannelGroup | null> {
    return one((await this.#state()).channelGroups, (group) => group.id === groupId);
  }

  async getChannelNavigation(channelId: string, personId: string): Promise<ChannelNavigation> {
    return (
      one(
        (await this.#state()).navigation,
        (navigation) => navigation.channelId === channelId && navigation.personId === personId,
      ) ?? { channelId, muted: false, personId, pinned: false, position: 0 }
    );
  }

  async getChartDefinition(channelId: string): Promise<ChartDefinition | null> {
    return one(
      (await this.#state()).chartDefinitions,
      (definition) => definition.channelId === channelId,
    );
  }

  async getDictionaryEntry(entryId: string): Promise<DictionaryEntry | null> {
    return one((await this.#state()).dictionaryEntries, (entry) => entry.id === entryId);
  }

  async getInvitation(invitationId: string): Promise<ChannelInvitation | null> {
    return one((await this.#state()).invitations, (invitation) => invitation.id === invitationId);
  }

  async getMessage(messageId: string): Promise<Message | null> {
    return one((await this.#state()).messages, (message) => message.id === messageId);
  }

  async getMembership(channelId: string, personId: string): Promise<ChannelMembership | null> {
    return one(
      (await this.#state()).memberships,
      (membership) => membership.channelId === channelId && membership.personId === personId,
    );
  }

  async getPerson(personId: string): Promise<Person | null> {
    return one((await this.#state()).persons, (person) => person.id === personId);
  }

  async getTableDisplayFieldId(channelId: string): Promise<string | null> {
    return (
      one(
        (await this.#state()).tableDisplayFields,
        (setting) => setting.channelId === channelId,
      )?.displayFieldId ?? null
    );
  }

  async getTableRecord(recordId: string): Promise<TableRecord | null> {
    return one((await this.#state()).tableRecords, (record) => record.id === recordId);
  }

  async listChannels(personId: string): Promise<readonly Channel[]> {
    const state = await this.#state();
    return state.channels
      .filter((channel) => {
        const navigation = one(
          state.navigation,
          (candidate) => candidate.channelId === channel.id && candidate.personId === personId,
        );
        return (
          state.memberships.some(
            (membership) => membership.channelId === channel.id && membership.personId === personId,
          ) &&
          channel.deletedAt === undefined &&
          channel.purgedAt === undefined &&
          navigation?.archivedAt === undefined
        );
      })
      .sort((left, right) => {
        const leftNavigation = one(
          state.navigation,
          (candidate) => candidate.channelId === left.id && candidate.personId === personId,
        );
        const rightNavigation = one(
          state.navigation,
          (candidate) => candidate.channelId === right.id && candidate.personId === personId,
        );
        const pinned = Number(rightNavigation?.pinned ?? false) - Number(leftNavigation?.pinned ?? false);
        if (pinned !== 0) return pinned;
        if (leftNavigation?.pinned && rightNavigation?.pinned) {
          const position = leftNavigation.position - rightNavigation.position;
          if (position !== 0) return position;
        }
        const activity = latestActivityPosition(state, right.id) - latestActivityPosition(state, left.id);
        return activity || left.id.localeCompare(right.id);
      });
  }

  async listOwnedChannels(personId: string): Promise<readonly Channel[]> {
    return (await this.#state()).channels
      .filter((channel) => channel.ownerId === personId && channel.purgedAt === undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listActivities(channelId: string): Promise<readonly ChannelActivity[]> {
    return (await this.#state()).activities
      .filter((activity) => activity.channelId === channelId)
      .sort((left, right) => left.position - right.position);
  }

  async listChannelGroupEntries(groupId: string): Promise<readonly ChannelGroupEntry[]> {
    const state = await this.#state();
    return state.channelGroupEntries
      .filter((entry) => {
        const channel = one(state.channels, (candidate) => candidate.id === entry.channelId);
        return entry.groupId === groupId && channel?.deletedAt === undefined && channel?.purgedAt === undefined;
      })
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          left.position - right.position ||
          left.channelId.localeCompare(right.channelId),
      );
  }

  async listChannelGroups(personId: string): Promise<readonly ChannelGroup[]> {
    return (await this.#state()).channelGroups
      .filter((group) => group.personId === personId)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  }

  async listChannelNavigation(personId: string): Promise<readonly ChannelListItem[]> {
    const state = await this.#state();
    const channels = await this.listChannels(personId);
    return channels.map((channel) => {
      const navigation =
        one(
          state.navigation,
          (candidate) => candidate.channelId === channel.id && candidate.personId === personId,
        ) ?? { channelId: channel.id, muted: false, personId, pinned: false, position: 0 };
      const readPosition = navigation.lastReadActivityId
        ? one(state.activities, (activity) => activity.id === navigation.lastReadActivityId)?.position ?? 0
        : 0;
      return {
        channel,
        navigation,
        unreadCount: state.activities.filter(
          (activity) => activity.channelId === channel.id && activity.position > readPosition,
        ).length,
      };
    });
  }

  async listDictionaryEntries(channelId: string): Promise<readonly DictionaryEntry[]> {
    return (await this.#state()).dictionaryEntries
      .filter((entry) => entry.channelId === channelId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listMessages(channelId: string): Promise<readonly Message[]> {
    return (await this.#state()).messages
      .filter((message) => message.channelId === channelId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listOperations(channelId: string): Promise<readonly Operation[]> {
    return (await this.#state()).operations.filter((operation) => operation.channelId === channelId);
  }

  async listServiceOperations(): Promise<readonly Operation[]> {
    return (await this.#state()).operations.filter((operation) => operation.channelId === undefined);
  }

  async listSubscriptionEvents(afterPosition: number, limit: number): Promise<readonly SubscriptionEvent[]> {
    return (await this.#state()).events
      .filter((event) => event.position > afterPosition)
      .sort((left, right) => left.position - right.position)
      .slice(0, limit);
  }

  async listTableFields(channelId: string): Promise<readonly TableField[]> {
    return (await this.#state()).tableFields.filter((field) => field.channelId === channelId);
  }

  async listTableRecords(channelId: string): Promise<readonly TableRecord[]> {
    return (await this.#state()).tableRecords
      .filter((record) => record.channelId === channelId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async listTableViews(channelId: string, personId: string): Promise<readonly TableView[]> {
    return (await this.#state()).tableViews
      .filter(
        (view) =>
          view.channelId === channelId && (view.visibility === 'shared' || view.ownerId === personId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async close(): Promise<void> {
    await this.#client.close();
    this.#initialized = false;
  }
}
