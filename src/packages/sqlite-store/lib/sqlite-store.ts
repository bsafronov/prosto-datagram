import { Database } from 'bun:sqlite';

import {
  newId,
  nowIso,
  type Channel,
  type ChannelActivity,
  type ChannelMembership,
  type DatagramStore,
  type DomainChange,
  type JsonValue,
  type Message,
  type Operation,
  type Person,
  type TableField,
  type TableRecord,
} from '../../application/store';

interface PersonRow {
  created_at: string;
  display_name: string;
  id: string;
  is_operator: number;
}

interface ChannelRow {
  created_at: string;
  id: string;
  owner_id: string;
  title: string;
  type_id: string;
  type_version: string;
  updated_at: string;
}

interface MembershipRow {
  channel_id: string;
  person_id: string;
  role: ChannelMembership['role'];
}

interface TableFieldRow {
  channel_id: string;
  default_json: string | null;
  id: string;
  key: string;
  label: string;
  required: number;
  type: TableField['type'];
  unique_value: number;
}

interface TableRecordRow {
  channel_id: string;
  created_at: string;
  created_by: string;
  id: string;
  values_json: string;
}

interface MessageRow {
  author_id: string;
  channel_id: string;
  created_at: string;
  id: string;
  record_references_json: string;
  text: string;
}

interface OperationRow {
  action: string;
  actor_id: string;
  changes_json: string;
  channel_id: string | null;
  id: string;
  occurred_at: string;
  origin: Operation['origin'];
  status: Operation['status'];
}

interface ActivityRow {
  actor_id: string;
  channel_id: string;
  id: string;
  kind: string;
  occurred_at: string;
  operation_id: string;
}

const personFromRow = (row: PersonRow): Person => ({
  createdAt: row.created_at,
  displayName: row.display_name,
  id: row.id,
  isOperator: row.is_operator === 1,
});

const channelFromRow = (row: ChannelRow): Channel => ({
  createdAt: row.created_at,
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  typeId: row.type_id,
  typeVersion: row.type_version,
  updatedAt: row.updated_at,
});

const membershipFromRow = (row: MembershipRow): ChannelMembership => ({
  channelId: row.channel_id,
  personId: row.person_id,
  role: row.role,
});

const tableFieldFromRow = (row: TableFieldRow): TableField => ({
  channelId: row.channel_id,
  ...(row.default_json === null
    ? {}
    : { defaultValue: JSON.parse(row.default_json) as JsonValue }),
  id: row.id,
  key: row.key,
  label: row.label,
  required: row.required === 1,
  type: row.type,
  unique: row.unique_value === 1,
});

const tableRecordFromRow = (row: TableRecordRow): TableRecord => ({
  channelId: row.channel_id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  id: row.id,
  values: JSON.parse(row.values_json) as Record<string, JsonValue>,
});

const messageFromRow = (row: MessageRow): Message => ({
  authorId: row.author_id,
  channelId: row.channel_id,
  createdAt: row.created_at,
  id: row.id,
  recordReferences: JSON.parse(row.record_references_json) as string[],
  text: row.text,
});

const operationFromRow = (row: OperationRow): Operation => ({
  action: row.action,
  actorId: row.actor_id,
  changes: JSON.parse(row.changes_json) as DomainChange[],
  ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
  id: row.id,
  intent: row.action,
  occurredAt: row.occurred_at,
  origin: row.origin,
  result: row.status,
  status: row.status,
});

const activityFromRow = (row: ActivityRow): ChannelActivity => ({
  actorId: row.actor_id,
  channelId: row.channel_id,
  id: row.id,
  kind: row.kind,
  occurredAt: row.occurred_at,
  operationId: row.operation_id,
});

export class SqliteStore implements DatagramStore {
  readonly #database: Database;

  constructor(path: string) {
    this.#database = new Database(path, { create: true, strict: true });
  }

  async initialize(): Promise<void> {
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#database.exec('PRAGMA journal_mode = WAL;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        is_operator INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type_id TEXT NOT NULL,
        type_version TEXT NOT NULL,
        title TEXT NOT NULL,
        owner_id TEXT NOT NULL REFERENCES persons(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_memberships (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        person_id TEXT NOT NULL REFERENCES persons(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'contributor', 'viewer')),
        PRIMARY KEY (channel_id, person_id)
      );

      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL REFERENCES persons(id),
        origin TEXT NOT NULL,
        action TEXT NOT NULL,
        channel_id TEXT REFERENCES channels(id),
        status TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_activities (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        operation_id TEXT NOT NULL REFERENCES operations(id),
        kind TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES persons(id),
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS table_fields (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 0,
        unique_value INTEGER NOT NULL DEFAULT 0,
        default_json TEXT,
        UNIQUE (channel_id, key)
      );

      CREATE TABLE IF NOT EXISTS table_records (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        values_json TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES persons(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        author_id TEXT NOT NULL REFERENCES persons(id),
        text TEXT NOT NULL,
        record_references_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS channel_memberships_person
        ON channel_memberships(person_id, channel_id);
      CREATE INDEX IF NOT EXISTS channel_activities_channel_sequence
        ON channel_activities(channel_id, sequence);
      CREATE INDEX IF NOT EXISTS table_records_channel
        ON table_records(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_channel
        ON messages(channel_id, created_at);
    `);
  }

  async ensureLocalOwner(displayName = 'Local Owner'): Promise<Person> {
    const existing = this.#database
      .query('SELECT * FROM persons WHERE is_operator = 1 ORDER BY created_at LIMIT 1')
      .get() as PersonRow | null;
    if (existing) return personFromRow(existing);

    const person: Person = {
      createdAt: nowIso(),
      displayName,
      id: newId('person'),
      isOperator: true,
    };
    this.#database.run(
      'INSERT INTO persons (id, display_name, is_operator, created_at) VALUES (?, ?, 1, ?)',
      [person.id, person.displayName, person.createdAt],
    );
    return person;
  }

  async getPerson(personId: string): Promise<Person | null> {
    const row = this.#database.query('SELECT * FROM persons WHERE id = ?').get(personId) as
      | PersonRow
      | null;
    return row ? personFromRow(row) : null;
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    const row = this.#database.query('SELECT * FROM channels WHERE id = ?').get(channelId) as
      | ChannelRow
      | null;
    return row ? channelFromRow(row) : null;
  }

  async getMembership(channelId: string, personId: string): Promise<ChannelMembership | null> {
    const row = this.#database
      .query('SELECT * FROM channel_memberships WHERE channel_id = ? AND person_id = ?')
      .get(channelId, personId) as MembershipRow | null;
    return row ? membershipFromRow(row) : null;
  }

  async listChannels(personId: string): Promise<readonly Channel[]> {
    const rows = this.#database
      .query(
        `SELECT channels.*
         FROM channels
         INNER JOIN channel_memberships
           ON channel_memberships.channel_id = channels.id
         WHERE channel_memberships.person_id = ?
         ORDER BY channels.updated_at DESC, channels.id`,
      )
      .all(personId) as ChannelRow[];
    return rows.map(channelFromRow);
  }

  async listActivities(channelId: string): Promise<readonly ChannelActivity[]> {
    const rows = this.#database
      .query(
        `SELECT actor_id, channel_id, id, kind, occurred_at, operation_id
         FROM channel_activities
         WHERE channel_id = ?
         ORDER BY sequence`,
      )
      .all(channelId) as ActivityRow[];
    return rows.map(activityFromRow);
  }

  async listTableFields(channelId: string): Promise<readonly TableField[]> {
    const rows = this.#database
      .query('SELECT * FROM table_fields WHERE channel_id = ? ORDER BY rowid')
      .all(channelId) as TableFieldRow[];
    return rows.map(tableFieldFromRow);
  }

  async listTableRecords(channelId: string): Promise<readonly TableRecord[]> {
    const rows = this.#database
      .query('SELECT * FROM table_records WHERE channel_id = ? ORDER BY created_at, id')
      .all(channelId) as TableRecordRow[];
    return rows.map(tableRecordFromRow);
  }

  async listMessages(channelId: string): Promise<readonly Message[]> {
    const rows = this.#database
      .query('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at, id')
      .all(channelId) as MessageRow[];
    return rows.map(messageFromRow);
  }

  async listOperations(channelId: string): Promise<readonly Operation[]> {
    const rows = this.#database
      .query('SELECT * FROM operations WHERE channel_id = ? ORDER BY occurred_at, id')
      .all(channelId) as OperationRow[];
    return rows.map(operationFromRow);
  }

  async commit(operation: Operation): Promise<void> {
    const apply = this.#database.transaction((candidate: Operation) => {
      for (const change of candidate.changes) {
        if (change.kind !== 'activity.appended') this.#applyChange(change);
      }

      this.#database.run(
        `INSERT INTO operations
          (id, actor_id, origin, action, channel_id, status, changes_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidate.id,
          candidate.actorId,
          candidate.origin,
          candidate.action,
          candidate.channelId ?? null,
          candidate.status,
          JSON.stringify(candidate.changes),
          candidate.occurredAt,
        ],
      );

      for (const change of candidate.changes) {
        if (change.kind === 'activity.appended') this.#applyChange(change);
      }
    });
    apply(operation);
  }

  #applyChange(change: DomainChange): void {
    switch (change.kind) {
      case 'person.created':
        this.#database.run(
          `INSERT INTO persons (id, display_name, is_operator, created_at)
           VALUES (?, ?, ?, ?)`,
          [
            change.person.id,
            change.person.displayName,
            change.person.isOperator ? 1 : 0,
            change.person.createdAt,
          ],
        );
        return;
      case 'channel.created':
        this.#database.run(
          `INSERT INTO channels
           (id, type_id, type_version, title, owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            change.channel.id,
            change.channel.typeId,
            change.channel.typeVersion,
            change.channel.title,
            change.channel.ownerId,
            change.channel.createdAt,
            change.channel.updatedAt,
          ],
        );
        return;
      case 'membership.granted':
        this.#database.run(
          `INSERT INTO channel_memberships (channel_id, person_id, role)
           VALUES (?, ?, ?)
           ON CONFLICT(channel_id, person_id) DO UPDATE SET role = excluded.role`,
          [change.membership.channelId, change.membership.personId, change.membership.role],
        );
        return;
      case 'membership.reverted': {
        const result = change.restoredRole
          ? this.#database.run(
              `UPDATE channel_memberships
               SET role = ?
               WHERE channel_id = ? AND person_id = ? AND role = ?`,
              [change.restoredRole, change.channelId, change.personId, change.expectedRole],
            )
          : this.#database.run(
              `DELETE FROM channel_memberships
               WHERE channel_id = ? AND person_id = ? AND role = ?`,
              [change.channelId, change.personId, change.expectedRole],
            );
        if (result.changes !== 1) throw new Error('Membership changed after original Operation');
        return;
      }
      case 'table.field-added':
        this.#database.run(
          `INSERT INTO table_fields
            (id, channel_id, key, label, type, required, unique_value, default_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            change.field.id,
            change.field.channelId,
            change.field.key,
            change.field.label,
            change.field.type,
            change.field.required ? 1 : 0,
            change.field.unique ? 1 : 0,
            change.field.defaultValue === undefined
              ? null
              : JSON.stringify(change.field.defaultValue),
          ],
        );
        return;
      case 'table.record-created':
        this.#database.run(
          `INSERT INTO table_records (id, channel_id, values_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            change.record.id,
            change.record.channelId,
            JSON.stringify(change.record.values),
            change.record.createdBy,
            change.record.createdAt,
          ],
        );
        return;
      case 'discussion.message-posted':
        this.#database.run(
          `INSERT INTO messages
            (id, channel_id, author_id, text, record_references_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            change.message.id,
            change.message.channelId,
            change.message.authorId,
            change.message.text,
            JSON.stringify(change.message.recordReferences),
            change.message.createdAt,
          ],
        );
        return;
      case 'activity.appended':
        this.#database.run(
          `INSERT INTO channel_activities
            (id, channel_id, operation_id, kind, actor_id, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            change.activity.id,
            change.activity.channelId,
            change.activity.operationId,
            change.activity.kind,
            change.activity.actorId,
            change.activity.occurredAt,
          ],
        );
        this.#database.run(
          'UPDATE channels SET updated_at = ? WHERE id = ?',
          [change.activity.occurredAt, change.activity.channelId],
        );
        return;
    }
  }

  async close(): Promise<void> {
    this.#database.close(false);
  }
}
