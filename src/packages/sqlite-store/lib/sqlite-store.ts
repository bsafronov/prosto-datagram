import { Database } from 'bun:sqlite';

import {
  newId,
  nowIso,
  type Channel,
  type ChannelActivity,
  type ChannelGroup,
  type ChannelGroupEntry,
  type ChannelInvitation,
  type ChannelListItem,
  type ChannelMembership,
  type ChannelNavigation,
  type DatagramStore,
  type DomainChange,
  type JsonValue,
  type Message,
  type MessageRevision,
  type Operation,
  type Person,
  type TableField,
  type TableRecord,
  type TableView,
} from '../../application/store';

interface PersonRow {
  created_at: string;
  deactivated_at: string | null;
  display_name: string;
  id: string;
  is_operator: number;
}

interface InvitationRow {
  accepted_at: string | null;
  accepted_by: string | null;
  channel_id: string;
  created_at: string;
  created_by: string;
  expires_at: string;
  id: string;
  proposed_role: ChannelInvitation['proposedRole'];
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
  tombstoned_at: string | null;
  tombstoned_by: string | null;
  updated_at: string | null;
  values_json: string;
}

interface TableViewRow {
  channel_id: string;
  created_at: string;
  definition_json: string;
  id: string;
  name: string;
  owner_id: string;
  visibility: TableView['visibility'];
}

interface MessageRow {
  author_id: string;
  channel_id: string;
  created_at: string;
  id: string;
  record_references_json: string;
  reply_to_message_id: string | null;
  text: string;
  tombstoned_at: string | null;
  tombstoned_by: string | null;
}

interface MessageRevisionRow {
  created_at: string;
  editor_id: string;
  id: string;
  message_id: string;
  text: string;
}

interface OperationRow {
  action: string;
  actor_id: string;
  changes_json: string;
  channel_id: string | null;
  id: string;
  intent_json: string;
  occurred_at: string;
  origin: Operation['origin'];
  result_json: string;
  status: Operation['status'];
}

interface TableInfoRow {
  name: string;
}

interface ActivityRow {
  actor_id: string;
  channel_id: string;
  id: string;
  kind: string;
  occurred_at: string;
  operation_id: string;
}

interface NavigationRow {
  archived_at: string | null;
  channel_id: string;
  last_read_activity_id: string | null;
  muted: number;
  person_id: string;
  pinned: number;
  position: number;
}

interface ChannelGroupRow {
  created_at: string;
  id: string;
  name: string;
  person_id: string;
  position: number;
}

interface ChannelGroupEntryRow {
  channel_id: string;
  group_id: string;
  pinned: number;
  position: number;
}

interface ChannelListRow extends ChannelRow, NavigationRow {
  unread_count: number;
}

const personFromRow = (row: PersonRow): Person => ({
  createdAt: row.created_at,
  ...(row.deactivated_at === null ? {} : { deactivatedAt: row.deactivated_at }),
  displayName: row.display_name,
  id: row.id,
  isOperator: row.is_operator === 1,
});

const invitationFromRow = (row: InvitationRow): ChannelInvitation => ({
  ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
  ...(row.accepted_by === null ? {} : { acceptedBy: row.accepted_by }),
  channelId: row.channel_id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  expiresAt: row.expires_at,
  id: row.id,
  proposedRole: row.proposed_role,
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
  ...(row.tombstoned_at === null ? {} : { tombstonedAt: row.tombstoned_at }),
  ...(row.tombstoned_by === null ? {} : { tombstonedBy: row.tombstoned_by }),
  ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
  values: JSON.parse(row.values_json) as Record<string, JsonValue>,
});

const tableViewFromRow = (row: TableViewRow): TableView => {
  const definition = JSON.parse(row.definition_json) as Pick<
    TableView,
    'filters' | 'grouping' | 'sorting' | 'visibleFieldIds'
  >;
  return {
    channelId: row.channel_id,
    createdAt: row.created_at,
    ...definition,
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    visibility: row.visibility,
  };
};

const messageRevisionFromRow = (row: MessageRevisionRow): MessageRevision => ({
  createdAt: row.created_at,
  editorId: row.editor_id,
  id: row.id,
  text: row.text,
});

const messageFromRow = (
  row: MessageRow,
  revisions: readonly MessageRevision[],
): Message => ({
  authorId: row.author_id,
  channelId: row.channel_id,
  createdAt: row.created_at,
  id: row.id,
  recordReferences: JSON.parse(row.record_references_json) as string[],
  ...(row.reply_to_message_id === null
    ? {}
    : { replyToMessageId: row.reply_to_message_id }),
  revisions,
  text: row.text,
  ...(row.tombstoned_at === null ? {} : { tombstonedAt: row.tombstoned_at }),
  ...(row.tombstoned_by === null ? {} : { tombstonedBy: row.tombstoned_by }),
});

const operationFromRow = (row: OperationRow): Operation => ({
  action: row.action,
  actorId: row.actor_id,
  changes: JSON.parse(row.changes_json) as DomainChange[],
  ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
  id: row.id,
  intent: JSON.parse(row.intent_json) as string,
  occurredAt: row.occurred_at,
  origin: row.origin,
  result: JSON.parse(row.result_json) as JsonValue,
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

const navigationFromRow = (row: NavigationRow): ChannelNavigation => ({
  ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  channelId: row.channel_id,
  ...(row.last_read_activity_id === null
    ? {}
    : { lastReadActivityId: row.last_read_activity_id }),
  muted: row.muted === 1,
  personId: row.person_id,
  pinned: row.pinned === 1,
  position: row.position,
});

const groupFromRow = (row: ChannelGroupRow): ChannelGroup => ({
  createdAt: row.created_at,
  id: row.id,
  name: row.name,
  personId: row.person_id,
  position: row.position,
});

const groupEntryFromRow = (row: ChannelGroupEntryRow): ChannelGroupEntry => ({
  channelId: row.channel_id,
  groupId: row.group_id,
  pinned: row.pinned === 1,
  position: row.position,
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
        created_at TEXT NOT NULL,
        deactivated_at TEXT
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

      CREATE UNIQUE INDEX IF NOT EXISTS channel_single_owner
        ON channel_memberships(channel_id) WHERE role = 'owner';

      CREATE TABLE IF NOT EXISTS channel_invitations (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        proposed_role TEXT NOT NULL CHECK (proposed_role IN ('admin', 'contributor', 'viewer')),
        expires_at TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES persons(id),
        created_at TEXT NOT NULL,
        accepted_by TEXT REFERENCES persons(id),
        accepted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL REFERENCES persons(id),
        origin TEXT NOT NULL,
        action TEXT NOT NULL,
        channel_id TEXT REFERENCES channels(id),
        status TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS channel_navigation (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        person_id TEXT NOT NULL REFERENCES persons(id),
        archived_at TEXT,
        muted INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        last_read_activity_id TEXT REFERENCES channel_activities(id),
        PRIMARY KEY (channel_id, person_id),
        FOREIGN KEY (channel_id, person_id)
          REFERENCES channel_memberships(channel_id, person_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS channel_groups (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES persons(id),
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (person_id, name)
      );

      CREATE TABLE IF NOT EXISTS channel_group_entries (
        group_id TEXT NOT NULL REFERENCES channel_groups(id),
        channel_id TEXT NOT NULL REFERENCES channels(id),
        pinned INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, channel_id)
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
        created_at TEXT NOT NULL,
        updated_at TEXT,
        tombstoned_at TEXT,
        tombstoned_by TEXT REFERENCES persons(id)
      );

      CREATE TABLE IF NOT EXISTS table_settings (
        channel_id TEXT PRIMARY KEY REFERENCES channels(id),
        display_field_id TEXT REFERENCES table_fields(id)
      );

      CREATE TABLE IF NOT EXISTS table_views (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        name TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('personal', 'shared')),
        owner_id TEXT NOT NULL REFERENCES persons(id),
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        author_id TEXT NOT NULL REFERENCES persons(id),
        text TEXT NOT NULL,
        record_references_json TEXT NOT NULL,
        reply_to_message_id TEXT REFERENCES messages(id),
        created_at TEXT NOT NULL,
        tombstoned_at TEXT,
        tombstoned_by TEXT REFERENCES persons(id)
      );

      CREATE TABLE IF NOT EXISTS message_revisions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        editor_id TEXT NOT NULL REFERENCES persons(id),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS channel_memberships_person
        ON channel_memberships(person_id, channel_id);
      CREATE INDEX IF NOT EXISTS channel_activities_channel_sequence
        ON channel_activities(channel_id, sequence);
      CREATE INDEX IF NOT EXISTS channel_navigation_person
        ON channel_navigation(person_id, archived_at, pinned, position);
      CREATE INDEX IF NOT EXISTS channel_groups_person
        ON channel_groups(person_id, position, id);
      CREATE INDEX IF NOT EXISTS channel_group_entries_group
        ON channel_group_entries(group_id, pinned, position, channel_id);

      CREATE TRIGGER IF NOT EXISTS channel_group_entry_requires_membership_insert
      BEFORE INSERT ON channel_group_entries
      WHEN NOT EXISTS (
        SELECT 1
        FROM channel_groups
        INNER JOIN channel_memberships
          ON channel_memberships.person_id = channel_groups.person_id
        WHERE channel_groups.id = NEW.group_id
          AND channel_memberships.channel_id = NEW.channel_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Channel Group entry requires membership');
      END;

      CREATE TRIGGER IF NOT EXISTS channel_navigation_read_activity_insert
      BEFORE INSERT ON channel_navigation
      WHEN NEW.last_read_activity_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM channel_activities
        WHERE id = NEW.last_read_activity_id AND channel_id = NEW.channel_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Read Activity must belong to Channel');
      END;

      CREATE TRIGGER IF NOT EXISTS channel_navigation_read_activity_update
      BEFORE UPDATE ON channel_navigation
      WHEN NEW.last_read_activity_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM channel_activities
        WHERE id = NEW.last_read_activity_id AND channel_id = NEW.channel_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Read Activity must belong to Channel');
      END;

      CREATE TRIGGER IF NOT EXISTS channel_group_entry_requires_membership_update
      BEFORE UPDATE ON channel_group_entries
      WHEN NOT EXISTS (
        SELECT 1
        FROM channel_groups
        INNER JOIN channel_memberships
          ON channel_memberships.person_id = channel_groups.person_id
        WHERE channel_groups.id = NEW.group_id
          AND channel_memberships.channel_id = NEW.channel_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Channel Group entry requires membership');
      END;

      CREATE TRIGGER IF NOT EXISTS membership_removal_cleans_personal_groups
      AFTER DELETE ON channel_memberships
      BEGIN
        DELETE FROM channel_group_entries
        WHERE channel_id = OLD.channel_id
          AND group_id IN (
            SELECT id FROM channel_groups WHERE person_id = OLD.person_id
          );
      END;
      CREATE INDEX IF NOT EXISTS table_records_channel
        ON table_records(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_channel
        ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS message_revisions_message
        ON message_revisions(message_id, created_at, id);
    `);

    const personColumns = new Set(
      (this.#database.query('PRAGMA table_info(persons)').all() as TableInfoRow[]).map(
        (column) => column.name,
      ),
    );
    if (!personColumns.has('deactivated_at')) {
      this.#database.exec('ALTER TABLE persons ADD COLUMN deactivated_at TEXT;');
    }

    const messageColumns = new Set(
      (this.#database.query('PRAGMA table_info(messages)').all() as TableInfoRow[]).map(
        (column) => column.name,
      ),
    );
    if (!messageColumns.has('reply_to_message_id')) {
      this.#database.exec('ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;');
    }
    if (!messageColumns.has('tombstoned_at')) {
      this.#database.exec('ALTER TABLE messages ADD COLUMN tombstoned_at TEXT;');
    }
    if (!messageColumns.has('tombstoned_by')) {
      this.#database.exec('ALTER TABLE messages ADD COLUMN tombstoned_by TEXT;');
    }
    this.#database.exec(`
      INSERT INTO message_revisions (id, message_id, editor_id, text, created_at)
      SELECT 'revision_' || messages.id, messages.id, messages.author_id, messages.text,
             messages.created_at
      FROM messages
      WHERE NOT EXISTS (
        SELECT 1 FROM message_revisions WHERE message_revisions.message_id = messages.id
      );
    `);

    const operationColumns = new Set(
      (
        this.#database.query('PRAGMA table_info(operations)').all() as TableInfoRow[]
      ).map((column) => column.name),
    );
    if (!operationColumns.has('intent_json')) {
      this.#database.exec('ALTER TABLE operations ADD COLUMN intent_json TEXT;');
    }
    const missingIntents = this.#database
      .query('SELECT id, action FROM operations WHERE intent_json IS NULL')
      .all() as Array<{ action: string; id: string }>;
    const updateIntent = this.#database.prepare(
      'UPDATE operations SET intent_json = ? WHERE id = ?',
    );
    for (const row of missingIntents) updateIntent.run(JSON.stringify(row.action), row.id);
    if (!operationColumns.has('result_json')) {
      this.#database.exec('ALTER TABLE operations ADD COLUMN result_json TEXT;');
    }
    const missingResults = this.#database
      .query('SELECT id, status FROM operations WHERE result_json IS NULL')
      .all() as Array<{ id: string; status: string }>;
    const updateResult = this.#database.prepare(
      'UPDATE operations SET result_json = ? WHERE id = ?',
    );
    for (const row of missingResults) updateResult.run(JSON.stringify(row.status), row.id);

    const recordColumns = new Set(
      (
        this.#database.query('PRAGMA table_info(table_records)').all() as TableInfoRow[]
      ).map((column) => column.name),
    );
    if (!recordColumns.has('updated_at')) {
      this.#database.exec('ALTER TABLE table_records ADD COLUMN updated_at TEXT;');
    }
    if (!recordColumns.has('tombstoned_at')) {
      this.#database.exec('ALTER TABLE table_records ADD COLUMN tombstoned_at TEXT;');
    }
    if (!recordColumns.has('tombstoned_by')) {
      this.#database.exec('ALTER TABLE table_records ADD COLUMN tombstoned_by TEXT;');
    }
  }

  async ensureLocalOwner(displayName = 'Local Owner'): Promise<Person> {
    const existing = this.#database
      .query(
        `SELECT * FROM persons
         WHERE is_operator = 1 AND deactivated_at IS NULL
         ORDER BY created_at LIMIT 1`,
      )
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

  async getActivity(activityId: string): Promise<ChannelActivity | null> {
    const row = this.#database
      .query(
        `SELECT actor_id, channel_id, id, kind, occurred_at, operation_id
         FROM channel_activities WHERE id = ?`,
      )
      .get(activityId) as ActivityRow | null;
    return row ? activityFromRow(row) : null;
  }

  async getChannelGroup(groupId: string): Promise<ChannelGroup | null> {
    const row = this.#database
      .query('SELECT * FROM channel_groups WHERE id = ?')
      .get(groupId) as ChannelGroupRow | null;
    return row ? groupFromRow(row) : null;
  }

  async getChannelNavigation(
    channelId: string,
    personId: string,
  ): Promise<ChannelNavigation> {
    const row = this.#database
      .query('SELECT * FROM channel_navigation WHERE channel_id = ? AND person_id = ?')
      .get(channelId, personId) as NavigationRow | null;
    return row
      ? navigationFromRow(row)
      : { channelId, muted: false, personId, pinned: false, position: 0 };
  }

  async getInvitation(invitationId: string): Promise<ChannelInvitation | null> {
    const row = this.#database
      .query('SELECT * FROM channel_invitations WHERE id = ?')
      .get(invitationId) as InvitationRow | null;
    return row ? invitationFromRow(row) : null;
  }

  async getMessage(messageId: string): Promise<Message | null> {
    const row = this.#database.query('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | MessageRow
      | null;
    return row ? messageFromRow(row, this.#listMessageRevisions(messageId)) : null;
  }

  async getMembership(channelId: string, personId: string): Promise<ChannelMembership | null> {
    const row = this.#database
      .query('SELECT * FROM channel_memberships WHERE channel_id = ? AND person_id = ?')
      .get(channelId, personId) as MembershipRow | null;
    return row ? membershipFromRow(row) : null;
  }

  async getTableDisplayFieldId(channelId: string): Promise<string | null> {
    const row = this.#database
      .query('SELECT display_field_id FROM table_settings WHERE channel_id = ?')
      .get(channelId) as { display_field_id: string | null } | null;
    return row?.display_field_id ?? null;
  }

  async getTableRecord(recordId: string): Promise<TableRecord | null> {
    const row = this.#database.query('SELECT * FROM table_records WHERE id = ?').get(recordId) as
      | TableRecordRow
      | null;
    return row ? tableRecordFromRow(row) : null;
  }

  async listChannels(personId: string): Promise<readonly Channel[]> {
    const rows = this.#database
      .query(
        `SELECT channels.*
         FROM channels
         INNER JOIN channel_memberships
           ON channel_memberships.channel_id = channels.id
         LEFT JOIN channel_navigation
           ON channel_navigation.channel_id = channels.id
          AND channel_navigation.person_id = channel_memberships.person_id
         WHERE channel_memberships.person_id = ?
           AND channel_navigation.archived_at IS NULL
         ORDER BY COALESCE(channel_navigation.pinned, 0) DESC,
                  CASE WHEN channel_navigation.pinned = 1 THEN channel_navigation.position END,
                  (SELECT MAX(sequence) FROM channel_activities
                   WHERE channel_id = channels.id) DESC,
                  channels.id`,
      )
      .all(personId) as ChannelRow[];
    return rows.map(channelFromRow);
  }

  async listOwnedChannels(personId: string): Promise<readonly Channel[]> {
    const rows = this.#database
      .query('SELECT * FROM channels WHERE owner_id = ? ORDER BY created_at, id')
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

  async listChannelGroups(personId: string): Promise<readonly ChannelGroup[]> {
    const rows = this.#database
      .query('SELECT * FROM channel_groups WHERE person_id = ? ORDER BY position, id')
      .all(personId) as ChannelGroupRow[];
    return rows.map(groupFromRow);
  }

  async listChannelGroupEntries(groupId: string): Promise<readonly ChannelGroupEntry[]> {
    const rows = this.#database
      .query(
        `SELECT * FROM channel_group_entries
         WHERE group_id = ? ORDER BY pinned DESC, position, channel_id`,
      )
      .all(groupId) as ChannelGroupEntryRow[];
    return rows.map(groupEntryFromRow);
  }

  async listChannelNavigation(personId: string): Promise<readonly ChannelListItem[]> {
    const rows = this.#database
      .query(
        `SELECT channels.*,
                channel_memberships.person_id,
                navigation.archived_at,
                navigation.last_read_activity_id,
                COALESCE(navigation.muted, 0) AS muted,
                COALESCE(navigation.pinned, 0) AS pinned,
                COALESCE(navigation.position, 0) AS position,
                COUNT(unread.id) AS unread_count
         FROM channels
         INNER JOIN channel_memberships
           ON channel_memberships.channel_id = channels.id
          AND channel_memberships.person_id = ?
         LEFT JOIN channel_navigation AS navigation
           ON navigation.channel_id = channels.id
          AND navigation.person_id = channel_memberships.person_id
         LEFT JOIN channel_activities AS read_activity
           ON read_activity.id = navigation.last_read_activity_id
         LEFT JOIN channel_activities AS unread
           ON unread.channel_id = channels.id
          AND unread.sequence > COALESCE(read_activity.sequence, 0)
         GROUP BY channels.id
         ORDER BY COALESCE(navigation.pinned, 0) DESC,
                  CASE WHEN navigation.pinned = 1 THEN navigation.position END,
                  (SELECT MAX(sequence) FROM channel_activities
                   WHERE channel_id = channels.id) DESC,
                  channels.id`,
      )
      .all(personId) as ChannelListRow[];
    return rows.map((row) => ({
      channel: channelFromRow(row),
      navigation: navigationFromRow(row),
      unreadCount: row.unread_count,
    }));
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

  async listTableViews(channelId: string, personId: string): Promise<readonly TableView[]> {
    const rows = this.#database
      .query(
        `SELECT * FROM table_views
         WHERE channel_id = ? AND (visibility = 'shared' OR owner_id = ?)
         ORDER BY created_at, id`,
      )
      .all(channelId, personId) as TableViewRow[];
    return rows.map(tableViewFromRow);
  }

  async listMessages(channelId: string): Promise<readonly Message[]> {
    const rows = this.#database
      .query('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at, id')
      .all(channelId) as MessageRow[];
    return rows.map((row) => messageFromRow(row, this.#listMessageRevisions(row.id)));
  }

  #listMessageRevisions(messageId: string): readonly MessageRevision[] {
    const rows = this.#database
      .query(
        `SELECT * FROM message_revisions
         WHERE message_id = ?
         ORDER BY rowid`,
      )
      .all(messageId) as MessageRevisionRow[];
    return rows.map(messageRevisionFromRow);
  }

  async listOperations(channelId: string): Promise<readonly Operation[]> {
    const rows = this.#database
      .query('SELECT * FROM operations WHERE channel_id = ? ORDER BY rowid')
      .all(channelId) as OperationRow[];
    return rows.map(operationFromRow);
  }

  async listServiceOperations(): Promise<readonly Operation[]> {
    const rows = this.#database
      .query('SELECT * FROM operations WHERE channel_id IS NULL ORDER BY rowid')
      .all() as OperationRow[];
    return rows.map(operationFromRow);
  }

  async commit(operation: Operation): Promise<void> {
    const apply = this.#database.transaction((candidate: Operation) => {
      for (const change of candidate.changes) {
        if (change.kind !== 'activity.appended') this.#applyChange(change);
      }

      const invalidOwnership = this.#database
        .query(
          `SELECT channels.id
           FROM channels
           LEFT JOIN channel_memberships
             ON channel_memberships.channel_id = channels.id
            AND channel_memberships.role = 'owner'
           GROUP BY channels.id
           HAVING COUNT(channel_memberships.person_id) <> 1
              OR MAX(channel_memberships.person_id = channels.owner_id) <> 1
           LIMIT 1`,
        )
        .get();
      if (invalidOwnership) throw new Error('Each Channel must have exactly one Owner');

      this.#database.run(
        `INSERT INTO operations
          (id, actor_id, origin, action, channel_id, status, changes_json, intent_json,
           result_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidate.id,
          candidate.actorId,
          candidate.origin,
          candidate.action,
          candidate.channelId ?? null,
          candidate.status,
          JSON.stringify(candidate.changes),
          JSON.stringify(candidate.intent),
          JSON.stringify(candidate.result),
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
      case 'person.deactivated': {
        const ownedChannel = this.#database
          .query('SELECT id FROM channels WHERE owner_id = ? LIMIT 1')
          .get(change.personId);
        if (ownedChannel) {
          throw new Error('Channel ownership must be transferred before deactivation');
        }
        const result = this.#database.run(
          `UPDATE persons SET deactivated_at = ?
           WHERE id = ? AND deactivated_at IS NULL`,
          [change.deactivatedAt, change.personId],
        );
        if (result.changes !== 1) throw new Error('Person is already deactivated');
        return;
      }
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
        if (change.membership.role === 'owner') {
          const channel = this.#database
            .query('SELECT owner_id FROM channels WHERE id = ?')
            .get(change.membership.channelId) as { owner_id: string } | null;
          if (channel?.owner_id !== change.membership.personId) {
            throw new Error('Ownership requires an ownership transfer');
          }
        } else {
          const channel = this.#database
            .query('SELECT owner_id FROM channels WHERE id = ?')
            .get(change.membership.channelId) as { owner_id: string } | null;
          if (channel?.owner_id === change.membership.personId) {
            throw new Error('Channel Owner cannot receive a non-owner role');
          }
        }
        this.#database.run(
          `INSERT INTO channel_memberships (channel_id, person_id, role)
           VALUES (?, ?, ?)
           ON CONFLICT(channel_id, person_id) DO UPDATE SET role = excluded.role`,
          [change.membership.channelId, change.membership.personId, change.membership.role],
        );
        return;
      case 'membership.reverted': {
        if (change.expectedRole === 'owner') {
          throw new Error('Channel Owner membership cannot be reverted');
        }
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
      case 'channel.ownership-transferred': {
        const channelUpdate = this.#database.run(
          'UPDATE channels SET owner_id = ? WHERE id = ? AND owner_id = ?',
          [change.nextOwnerId, change.channelId, change.previousOwnerId],
        );
        if (channelUpdate.changes !== 1) throw new Error('Channel ownership changed');
        const oldOwnerUpdate = this.#database.run(
          `UPDATE channel_memberships SET role = 'admin'
           WHERE channel_id = ? AND person_id = ? AND role = 'owner'`,
          [change.channelId, change.previousOwnerId],
        );
        if (oldOwnerUpdate.changes !== 1) throw new Error('Previous Owner membership changed');
        this.#database.run(
          `INSERT INTO channel_memberships (channel_id, person_id, role)
           VALUES (?, ?, 'owner')
           ON CONFLICT(channel_id, person_id) DO UPDATE SET role = 'owner'`,
          [change.channelId, change.nextOwnerId],
        );
        return;
      }
      case 'invitation.created':
        this.#database.run(
          `INSERT INTO channel_invitations
            (id, channel_id, proposed_role, expires_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            change.invitation.id,
            change.invitation.channelId,
            change.invitation.proposedRole,
            change.invitation.expiresAt,
            change.invitation.createdBy,
            change.invitation.createdAt,
          ],
        );
        return;
      case 'invitation.accepted': {
        const result = this.#database.run(
          `UPDATE channel_invitations SET accepted_by = ?, accepted_at = ?
           WHERE id = ? AND accepted_at IS NULL`,
          [change.acceptedBy, change.acceptedAt, change.invitationId],
        );
        if (result.changes !== 1) throw new Error('Invitation is already accepted');
        return;
      }
      case 'channel-group.created':
        this.#database.run(
          `INSERT INTO channel_groups (id, person_id, name, position, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            change.group.id,
            change.group.personId,
            change.group.name,
            change.group.position,
            change.group.createdAt,
          ],
        );
        return;
      case 'channel-group.updated': {
        const result = this.#database.run(
          `UPDATE channel_groups SET name = ?, position = ?
           WHERE id = ? AND person_id = ?`,
          [change.group.name, change.group.position, change.group.id, change.group.personId],
        );
        if (result.changes !== 1) throw new Error('Channel Group changed');
        return;
      }
      case 'channel-group.entry-set':
        this.#database.run(
          `INSERT INTO channel_group_entries (group_id, channel_id, pinned, position)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(group_id, channel_id) DO UPDATE SET
             pinned = excluded.pinned,
             position = excluded.position`,
          [
            change.entry.groupId,
            change.entry.channelId,
            change.entry.pinned ? 1 : 0,
            change.entry.position,
          ],
        );
        return;
      case 'channel-group.entry-removed': {
        const result = this.#database.run(
          'DELETE FROM channel_group_entries WHERE group_id = ? AND channel_id = ?',
          [change.groupId, change.channelId],
        );
        if (result.changes !== 1) throw new Error('Channel is not in Channel Group');
        return;
      }
      case 'channel-navigation.updated':
        this.#database.run(
          `INSERT INTO channel_navigation
            (channel_id, person_id, archived_at, muted, pinned, position, last_read_activity_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, person_id) DO UPDATE SET
             archived_at = excluded.archived_at,
             muted = excluded.muted,
             pinned = excluded.pinned,
             position = excluded.position,
             last_read_activity_id = excluded.last_read_activity_id`,
          [
            change.navigation.channelId,
            change.navigation.personId,
            change.navigation.archivedAt ?? null,
            change.navigation.muted ? 1 : 0,
            change.navigation.pinned ? 1 : 0,
            change.navigation.position,
            change.navigation.lastReadActivityId ?? null,
          ],
        );
        return;
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
      case 'table.display-field-set':
        this.#database.run(
          `INSERT INTO table_settings (channel_id, display_field_id) VALUES (?, ?)
           ON CONFLICT(channel_id) DO UPDATE SET display_field_id = excluded.display_field_id`,
          [change.channelId, change.displayFieldId ?? null],
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
      case 'table.record-updated': {
        const result = this.#database.run(
          'UPDATE table_records SET values_json = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(change.values), change.updatedAt, change.recordId],
        );
        if (result.changes !== 1) throw new Error('Table Record is unavailable');
        return;
      }
      case 'table.record-tombstoned': {
        const result = this.#database.run(
          `UPDATE table_records SET tombstoned_at = ?, tombstoned_by = ?, updated_at = ?
           WHERE id = ? AND tombstoned_at IS NULL`,
          [change.tombstonedAt, change.actorId, change.tombstonedAt, change.recordId],
        );
        if (result.changes !== 1) throw new Error('Table Record is already tombstoned');
        return;
      }
      case 'table.record-restored': {
        const result = this.#database.run(
          `UPDATE table_records
           SET tombstoned_at = NULL, tombstoned_by = NULL, updated_at = ?
           WHERE id = ? AND tombstoned_at IS NOT NULL`,
          [change.restoredAt, change.recordId],
        );
        if (result.changes !== 1) throw new Error('Table Record is not tombstoned');
        return;
      }
      case 'table.view-saved':
        this.#database.run(
          `INSERT INTO table_views
            (id, channel_id, name, visibility, owner_id, definition_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             visibility = excluded.visibility,
             definition_json = excluded.definition_json`,
          [
            change.view.id,
            change.view.channelId,
            change.view.name,
            change.view.visibility,
            change.view.ownerId,
            JSON.stringify({
              filters: change.view.filters,
              grouping: change.view.grouping,
              sorting: change.view.sorting,
              visibleFieldIds: change.view.visibleFieldIds,
            }),
            change.view.createdAt,
          ],
        );
        return;
      case 'discussion.message-posted':
        if (change.message.revisions.length !== 1) {
          throw new Error('Posted Message must have exactly one initial revision');
        }
        if (
          change.message.revisions[0]!.editorId !== change.message.authorId ||
          change.message.revisions[0]!.text !== change.message.text
        ) {
          throw new Error('Initial Message revision must match posted Message');
        }
        if (change.message.replyToMessageId !== undefined) {
          const replyTarget = this.#database
            .query('SELECT channel_id FROM messages WHERE id = ?')
            .get(change.message.replyToMessageId) as { channel_id: string } | null;
          if (replyTarget?.channel_id !== change.message.channelId) {
            throw new Error('Reply target must belong to the same Channel Discussion');
          }
        }
        this.#database.run(
          `INSERT INTO messages
            (id, channel_id, author_id, text, record_references_json, reply_to_message_id,
             created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            change.message.id,
            change.message.channelId,
            change.message.authorId,
            change.message.text,
            JSON.stringify(change.message.recordReferences),
            change.message.replyToMessageId ?? null,
            change.message.createdAt,
          ],
        );
        this.#database.run(
          `INSERT INTO message_revisions (id, message_id, editor_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            change.message.revisions[0]!.id,
            change.message.id,
            change.message.revisions[0]!.editorId,
            change.message.revisions[0]!.text,
            change.message.revisions[0]!.createdAt,
          ],
        );
        return;
      case 'discussion.message-edited': {
        const result = this.#database.run(
          'UPDATE messages SET text = ? WHERE id = ? AND tombstoned_at IS NULL',
          [change.revision.text, change.messageId],
        );
        if (result.changes !== 1) throw new Error('Message cannot be edited');
        this.#database.run(
          `INSERT INTO message_revisions (id, message_id, editor_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            change.revision.id,
            change.messageId,
            change.revision.editorId,
            change.revision.text,
            change.revision.createdAt,
          ],
        );
        return;
      }
      case 'discussion.message-tombstoned': {
        const result = this.#database.run(
          `UPDATE messages SET tombstoned_at = ?, tombstoned_by = ?
           WHERE id = ? AND tombstoned_at IS NULL`,
          [change.tombstonedAt, change.actorId, change.messageId],
        );
        if (result.changes !== 1) throw new Error('Message is already tombstoned');
        return;
      }
      case 'discussion.message-restored': {
        const result = this.#database.run(
          `UPDATE messages SET tombstoned_at = NULL, tombstoned_by = NULL
           WHERE id = ? AND tombstoned_at IS NOT NULL`,
          [change.messageId],
        );
        if (result.changes !== 1) throw new Error('Message is not tombstoned');
        return;
      }
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
        this.#database.run(
          `UPDATE channel_navigation SET archived_at = NULL
           WHERE channel_id = ? AND archived_at IS NOT NULL AND muted = 0`,
          [change.activity.channelId],
        );
        return;
    }
  }

  async close(): Promise<void> {
    this.#database.close(false);
  }
}
