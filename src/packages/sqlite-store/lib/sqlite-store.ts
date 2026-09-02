import { Database } from 'bun:sqlite';

import {
  applyOperation,
  type StoreState,
} from '../../application/transitions';

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
  type ChartDefinition,
  type DatagramStore,
  type DictionaryEntry,
  type DomainChange,
  type JsonValue,
  type Message,
  type MessageRevision,
  type Operation,
  type Person,
  type SubscriptionEvent,
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
  deleted_at: string | null;
  deleted_by: string | null;
  id: string;
  owner_id: string;
  purged_at: string | null;
  purged_by: string | null;
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
  cardinality: NonNullable<TableField['cardinality']> | null;
  channel_id: string;
  default_json: string | null;
  id: string;
  key: string;
  label: string;
  required: number;
  target_channel_id: string | null;
  tombstoned_at: string | null;
  tombstoned_by: string | null;
  type: TableField['type'];
  unique_value: number;
  version: number;
}

interface DictionaryEntryRow {
  channel_id: string;
  created_at: string;
  created_by: string;
  id: string;
  label: string;
  normalized_label: string;
  retired_at: string | null;
  retired_by: string | null;
  updated_at: string | null;
}

interface TableRecordRow {
  channel_id: string;
  created_at: string;
  created_by: string;
  id: string;
  field_versions_json: string;
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

interface ChartDefinitionRow {
  channel_id: string;
  definition_json: string;
  source_channel_id: string;
  version: number;
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
  position: number;
}

interface SubscriptionEventRow {
  action: string;
  activity_actor_id: string | null;
  activity_channel_id: string | null;
  activity_id: string | null;
  activity_kind: string | null;
  activity_occurred_at: string | null;
  activity_operation_id: string | null;
  activity_position: number | null;
  actor_id: string;
  channel_id: string | null;
  event_type: SubscriptionEvent['type'];
  id: string;
  occurred_at: string;
  operation_id: string;
  position: number;
  status: Operation['status'];
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
  ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  ...(row.deleted_by === null ? {} : { deletedBy: row.deleted_by }),
  id: row.id,
  ownerId: row.owner_id,
  ...(row.purged_at === null ? {} : { purgedAt: row.purged_at }),
  ...(row.purged_by === null ? {} : { purgedBy: row.purged_by }),
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
  ...(row.cardinality === null ? {} : { cardinality: row.cardinality }),
  channelId: row.channel_id,
  ...(row.default_json === null ? {} : { defaultValue: JSON.parse(row.default_json) as JsonValue }),
  id: row.id,
  key: row.key,
  label: row.label,
  required: row.required === 1,
  ...(row.target_channel_id === null ? {} : { targetChannelId: row.target_channel_id }),
  ...(row.tombstoned_at === null ? {} : { tombstonedAt: row.tombstoned_at }),
  ...(row.tombstoned_by === null ? {} : { tombstonedBy: row.tombstoned_by }),
  type: row.type,
  unique: row.unique_value === 1,
  version: row.version,
});

const dictionaryEntryFromRow = (row: DictionaryEntryRow): DictionaryEntry => ({
  channelId: row.channel_id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  id: row.id,
  label: row.label,
  normalizedLabel: row.normalized_label,
  ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  ...(row.retired_by === null ? {} : { retiredBy: row.retired_by }),
  ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
});

const tableRecordFromRow = (row: TableRecordRow): TableRecord => ({
  channelId: row.channel_id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  id: row.id,
  fieldVersions: JSON.parse(row.field_versions_json) as Record<string, number>,
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

const chartDefinitionFromRow = (row: ChartDefinitionRow): ChartDefinition => ({
  ...(JSON.parse(row.definition_json) as Pick<
    ChartDefinition,
    'aggregations' | 'filters' | 'grouping' | 'presentation'
  >),
  channelId: row.channel_id,
  sourceChannelId: row.source_channel_id,
  version: row.version,
});

const messageRevisionFromRow = (row: MessageRevisionRow): MessageRevision => ({
  createdAt: row.created_at,
  editorId: row.editor_id,
  id: row.id,
  text: row.text,
});

const messageFromRow = (row: MessageRow, revisions: readonly MessageRevision[]): Message => ({
  authorId: row.author_id,
  channelId: row.channel_id,
  createdAt: row.created_at,
  id: row.id,
  recordReferences: JSON.parse(row.record_references_json) as string[],
  ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
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
  position: row.position,
});

const navigationFromRow = (row: NavigationRow): ChannelNavigation => ({
  ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  channelId: row.channel_id,
  ...(row.last_read_activity_id === null ? {} : { lastReadActivityId: row.last_read_activity_id }),
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

const subscriptionEventFromRow = (row: SubscriptionEventRow): SubscriptionEvent => {
  if (row.event_type === 'activity') {
    if (
      row.activity_actor_id === null ||
      row.activity_channel_id === null ||
      row.activity_id === null ||
      row.activity_kind === null ||
      row.activity_occurred_at === null ||
      row.activity_operation_id === null ||
      row.activity_position === null
    ) throw new Error('Activity subscription event is incomplete');
    return {
      activity: {
        actorId: row.activity_actor_id,
        channelId: row.activity_channel_id,
        id: row.activity_id,
        kind: row.activity_kind,
        occurredAt: row.activity_occurred_at,
        operationId: row.activity_operation_id,
        position: row.activity_position,
      },
      id: row.id,
      position: row.position,
      type: 'activity',
    };
  }
  return {
    action: row.action,
    actorId: row.actor_id,
    ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
    id: row.id,
    occurredAt: row.occurred_at,
    operationId: row.operation_id,
    position: row.position,
    status: row.status,
    type: 'operation-result',
  };
};

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
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES persons(id),
        purged_at TEXT,
        purged_by TEXT REFERENCES persons(id)
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

      CREATE TABLE IF NOT EXISTS subscription_events (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL CHECK (event_type IN ('activity', 'operation-result')),
        operation_id TEXT NOT NULL REFERENCES operations(id),
        activity_id TEXT REFERENCES channel_activities(id),
        channel_id TEXT REFERENCES channels(id),
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
        target_channel_id TEXT REFERENCES channels(id),
        cardinality TEXT CHECK (cardinality IN ('one', 'many')),
        version INTEGER NOT NULL DEFAULT 1,
        tombstoned_at TEXT,
        tombstoned_by TEXT REFERENCES persons(id),
        UNIQUE (channel_id, key)
      );

      CREATE TABLE IF NOT EXISTS dictionary_entries (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        label TEXT NOT NULL,
        normalized_label TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES persons(id),
        created_at TEXT NOT NULL,
        updated_at TEXT,
        retired_at TEXT,
        retired_by TEXT REFERENCES persons(id)
      );

      CREATE TABLE IF NOT EXISTS table_records (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        values_json TEXT NOT NULL,
        field_versions_json TEXT NOT NULL DEFAULT '{}',
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

      CREATE TABLE IF NOT EXISTS chart_definitions (
        channel_id TEXT PRIMARY KEY REFERENCES channels(id),
        source_channel_id TEXT NOT NULL REFERENCES channels(id),
        definition_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
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
      CREATE INDEX IF NOT EXISTS dictionary_entries_channel
        ON dictionary_entries(channel_id, created_at, id);
      CREATE INDEX IF NOT EXISTS messages_channel
        ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS message_revisions_message
        ON message_revisions(message_id, created_at, id);
    `);

    const dictionaryTable = this.#database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dictionary_entries'")
      .get() as { sql: string } | null;
    if (dictionaryTable?.sql.includes('UNIQUE (channel_id, normalized_label)')) {
      this.#database.exec(`
        ALTER TABLE dictionary_entries RENAME TO dictionary_entries_legacy;
        CREATE TABLE dictionary_entries (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          label TEXT NOT NULL,
          normalized_label TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES persons(id),
          created_at TEXT NOT NULL,
          updated_at TEXT,
          retired_at TEXT,
          retired_by TEXT REFERENCES persons(id)
        );
        INSERT INTO dictionary_entries
          SELECT * FROM dictionary_entries_legacy;
        DROP TABLE dictionary_entries_legacy;
      `);
    }
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS dictionary_entries_channel
        ON dictionary_entries(channel_id, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS dictionary_entries_active_label
        ON dictionary_entries(channel_id, normalized_label)
        WHERE retired_at IS NULL;
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

    const channelColumns = new Set(
      (this.#database.query('PRAGMA table_info(channels)').all() as TableInfoRow[]).map(
        (column) => column.name,
      ),
    );
    if (!channelColumns.has('deleted_at')) {
      this.#database.exec('ALTER TABLE channels ADD COLUMN deleted_at TEXT;');
    }
    if (!channelColumns.has('deleted_by')) {
      this.#database.exec(
        'ALTER TABLE channels ADD COLUMN deleted_by TEXT REFERENCES persons(id);',
      );
    }
    if (!channelColumns.has('purged_at')) {
      this.#database.exec('ALTER TABLE channels ADD COLUMN purged_at TEXT;');
    }
    if (!channelColumns.has('purged_by')) {
      this.#database.exec(
        'ALTER TABLE channels ADD COLUMN purged_by TEXT REFERENCES persons(id);',
      );
    }

    const operationColumns = new Set(
      (this.#database.query('PRAGMA table_info(operations)').all() as TableInfoRow[]).map(
        (column) => column.name,
      ),
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
      (this.#database.query('PRAGMA table_info(table_records)').all() as TableInfoRow[]).map(
        (column) => column.name,
      ),
    );
    if (!recordColumns.has('updated_at')) {
      this.#database.exec('ALTER TABLE table_records ADD COLUMN updated_at TEXT;');
    }
    if (!recordColumns.has('field_versions_json')) {
      this.#database.exec(
        "ALTER TABLE table_records ADD COLUMN field_versions_json TEXT NOT NULL DEFAULT '{}';",
      );
    }
    if (!recordColumns.has('tombstoned_at')) {
      this.#database.exec('ALTER TABLE table_records ADD COLUMN tombstoned_at TEXT;');
    }
    if (!recordColumns.has('tombstoned_by')) {
      this.#database.exec('ALTER TABLE table_records ADD COLUMN tombstoned_by TEXT;');
    }
    const fieldColumns = new Set(
      (
        this.#database.query('PRAGMA table_info(table_fields)').all() as TableInfoRow[]
      ).map((column) => column.name),
    );
    if (!fieldColumns.has('target_channel_id')) {
      this.#database.exec(
        'ALTER TABLE table_fields ADD COLUMN target_channel_id TEXT REFERENCES channels(id);',
      );
    }
    if (!fieldColumns.has('cardinality')) {
      this.#database.exec(
        "ALTER TABLE table_fields ADD COLUMN cardinality TEXT CHECK (cardinality IN ('one', 'many'));",
      );
    }
    if (!fieldColumns.has('version')) {
      this.#database.exec(
        'ALTER TABLE table_fields ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
      );
    }
    if (!fieldColumns.has('tombstoned_at')) {
      this.#database.exec('ALTER TABLE table_fields ADD COLUMN tombstoned_at TEXT;');
    }
    if (!fieldColumns.has('tombstoned_by')) {
      this.#database.exec('ALTER TABLE table_fields ADD COLUMN tombstoned_by TEXT;');
    }
    const recordsWithoutVersions = this.#database
      .query("SELECT id, values_json FROM table_records WHERE field_versions_json = '{}'")
      .all() as Array<{ id: string; values_json: string }>;
    const updateVersions = this.#database.prepare(
      'UPDATE table_records SET field_versions_json = ? WHERE id = ?',
    );
    for (const row of recordsWithoutVersions) {
      const values = JSON.parse(row.values_json) as Record<string, JsonValue>;
      updateVersions.run(
        JSON.stringify(Object.fromEntries(Object.keys(values).map((key) => [key, 1]))),
        row.id,
      );
    }
  }

  async findLocalOwner(): Promise<Person | undefined> {
    const existing = this.#database
      .query(
        `SELECT * FROM persons
         WHERE is_operator = 1 AND deactivated_at IS NULL
         ORDER BY created_at LIMIT 1`,
      )
      .get() as PersonRow | null;
    return existing === null ? undefined : personFromRow(existing);
  }

  async ensureLocalOwner(displayName = 'Local Owner'): Promise<Person> {
    const existing = await this.findLocalOwner();
    if (existing !== undefined) return existing;

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
    const row = this.#database
      .query('SELECT * FROM persons WHERE id = ?')
      .get(personId) as PersonRow | null;
    return row ? personFromRow(row) : null;
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    const row = this.#database
      .query('SELECT * FROM channels WHERE id = ?')
      .get(channelId) as ChannelRow | null;
    return row ? channelFromRow(row) : null;
  }

  async getActivity(activityId: string): Promise<ChannelActivity | null> {
    const row = this.#database
      .query(
        `SELECT actor_id, channel_id, id, kind, occurred_at, operation_id,
                sequence AS position
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

  async getChannelNavigation(channelId: string, personId: string): Promise<ChannelNavigation> {
    const row = this.#database
      .query('SELECT * FROM channel_navigation WHERE channel_id = ? AND person_id = ?')
      .get(channelId, personId) as NavigationRow | null;
    return row
      ? navigationFromRow(row)
      : { channelId, muted: false, personId, pinned: false, position: 0 };
  }

  async getChartDefinition(channelId: string): Promise<ChartDefinition | null> {
    const row = this.#database
      .query('SELECT * FROM chart_definitions WHERE channel_id = ?')
      .get(channelId) as ChartDefinitionRow | null;
    return row ? chartDefinitionFromRow(row) : null;
  }

  async getInvitation(invitationId: string): Promise<ChannelInvitation | null> {
    const row = this.#database
      .query('SELECT * FROM channel_invitations WHERE id = ?')
      .get(invitationId) as InvitationRow | null;
    return row ? invitationFromRow(row) : null;
  }

  async getMessage(messageId: string): Promise<Message | null> {
    const row = this.#database
      .query('SELECT * FROM messages WHERE id = ?')
      .get(messageId) as MessageRow | null;
    return row ? messageFromRow(row, this.#listMessageRevisions(messageId)) : null;
  }

  async getDictionaryEntry(entryId: string): Promise<DictionaryEntry | null> {
    const row = this.#database
      .query('SELECT * FROM dictionary_entries WHERE id = ?')
      .get(entryId) as DictionaryEntryRow | null;
    return row ? dictionaryEntryFromRow(row) : null;
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
    const row = this.#database
      .query('SELECT * FROM table_records WHERE id = ?')
      .get(recordId) as TableRecordRow | null;
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
           AND channels.deleted_at IS NULL
           AND channels.purged_at IS NULL
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
      .query(
        'SELECT * FROM channels WHERE owner_id = ? AND purged_at IS NULL ORDER BY created_at, id',
      )
      .all(personId) as ChannelRow[];
    return rows.map(channelFromRow);
  }

  async listActivities(channelId: string): Promise<readonly ChannelActivity[]> {
    const rows = this.#database
      .query(
        `SELECT actor_id, channel_id, id, kind, occurred_at, operation_id,
                sequence AS position
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
        `SELECT channel_group_entries.*
         FROM channel_group_entries
         INNER JOIN channels ON channels.id = channel_group_entries.channel_id
         WHERE channel_group_entries.group_id = ?
           AND channels.deleted_at IS NULL
           AND channels.purged_at IS NULL
         ORDER BY channel_group_entries.pinned DESC,
                  channel_group_entries.position,
                  channel_group_entries.channel_id`,
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
         WHERE channels.deleted_at IS NULL
           AND channels.purged_at IS NULL
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

  async listDictionaryEntries(channelId: string): Promise<readonly DictionaryEntry[]> {
    const rows = this.#database
      .query('SELECT * FROM dictionary_entries WHERE channel_id = ? ORDER BY created_at, id')
      .all(channelId) as DictionaryEntryRow[];
    return rows.map(dictionaryEntryFromRow);
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

  async listSubscriptionEvents(
    afterPosition: number,
    limit: number,
  ): Promise<readonly SubscriptionEvent[]> {
    const rows = this.#database
      .query(
        `SELECT events.position,
                events.id,
                events.event_type,
                events.operation_id,
                events.channel_id,
                events.actor_id,
                events.occurred_at,
                operations.action,
                operations.status,
                activities.id AS activity_id,
                activities.channel_id AS activity_channel_id,
                activities.operation_id AS activity_operation_id,
                activities.kind AS activity_kind,
                activities.actor_id AS activity_actor_id,
                activities.occurred_at AS activity_occurred_at,
                activities.sequence AS activity_position
         FROM subscription_events AS events
         INNER JOIN operations ON operations.id = events.operation_id
         LEFT JOIN channel_activities AS activities ON activities.id = events.activity_id
         WHERE events.position > ?
         ORDER BY events.position
         LIMIT ?`,
      )
      .all(afterPosition, limit) as SubscriptionEventRow[];
    return rows.map(subscriptionEventFromRow);
  }

  async commit(operation: Operation): Promise<void> {
    const apply = this.#database.transaction((candidate: Operation) => {
      const state = this.#transitionState();
      applyOperation(state, candidate);
      this.#persistReducedState(state);
    });
    apply.immediate(operation);
  }

  #transitionState(): StoreState {
    const messages = this.#database.query('SELECT * FROM messages').all() as MessageRow[];
    const sequence = (table: string): number =>
      (this.#database.query('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
        | { seq: number }
        | null)?.seq ?? 0;
    const events = this.#database.query(
      `SELECT events.position,
              events.id,
              events.event_type,
              events.operation_id,
              events.channel_id,
              events.actor_id,
              events.occurred_at,
              operations.action,
              operations.status,
              activities.id AS activity_id,
              activities.channel_id AS activity_channel_id,
              activities.operation_id AS activity_operation_id,
              activities.kind AS activity_kind,
              activities.actor_id AS activity_actor_id,
              activities.occurred_at AS activity_occurred_at,
              activities.sequence AS activity_position
       FROM subscription_events AS events
       INNER JOIN operations ON operations.id = events.operation_id
       LEFT JOIN channel_activities AS activities ON activities.id = events.activity_id
       ORDER BY events.position`,
    ).all() as SubscriptionEventRow[];
    const tableDisplayFields = this.#database
      .query('SELECT channel_id, display_field_id FROM table_settings')
      .all() as Array<{ channel_id: string; display_field_id: string | null }>;

    return {
      schemaVersion: 1,
      activities: (
        this.#database.query('SELECT *, sequence AS position FROM channel_activities').all() as ActivityRow[]
      ).map(activityFromRow),
      activitySequence: sequence('channel_activities'),
      channelGroupEntries: (
        this.#database.query('SELECT * FROM channel_group_entries').all() as ChannelGroupEntryRow[]
      ).map(groupEntryFromRow),
      channelGroups: (this.#database.query('SELECT * FROM channel_groups').all() as ChannelGroupRow[]).map(
        groupFromRow,
      ),
      channels: (this.#database.query('SELECT * FROM channels').all() as ChannelRow[]).map(channelFromRow),
      chartDefinitions: (
        this.#database.query('SELECT * FROM chart_definitions').all() as ChartDefinitionRow[]
      ).map(chartDefinitionFromRow),
      dictionaryEntries: (
        this.#database.query('SELECT * FROM dictionary_entries').all() as DictionaryEntryRow[]
      ).map(dictionaryEntryFromRow),
      eventSequence: sequence('subscription_events'),
      events: events.map(subscriptionEventFromRow),
      invitations: (
        this.#database.query('SELECT * FROM channel_invitations').all() as InvitationRow[]
      ).map(invitationFromRow),
      memberships: (
        this.#database.query('SELECT * FROM channel_memberships').all() as MembershipRow[]
      ).map(membershipFromRow),
      messages: messages.map((row) => messageFromRow(row, this.#listMessageRevisions(row.id))),
      navigation: (
        this.#database.query('SELECT * FROM channel_navigation').all() as NavigationRow[]
      ).map(navigationFromRow),
      operations: (this.#database.query('SELECT * FROM operations').all() as OperationRow[]).map(
        operationFromRow,
      ),
      persons: (this.#database.query('SELECT * FROM persons').all() as PersonRow[]).map(personFromRow),
      tableDisplayFields: tableDisplayFields.map((setting) => ({
        channelId: setting.channel_id,
        ...(setting.display_field_id === null ? {} : { displayFieldId: setting.display_field_id }),
      })),
      tableFields: (this.#database.query('SELECT * FROM table_fields').all() as TableFieldRow[]).map(
        tableFieldFromRow,
      ),
      tableRecords: (this.#database.query('SELECT * FROM table_records').all() as TableRecordRow[]).map(
        tableRecordFromRow,
      ),
      tableViews: (this.#database.query('SELECT * FROM table_views').all() as TableViewRow[]).map(
        tableViewFromRow,
      ),
    };
  }

  #persistReducedState(state: StoreState): void {
    this.#database.exec('PRAGMA defer_foreign_keys = ON;');
    this.#database.exec(`
      DELETE FROM subscription_events;
      DELETE FROM channel_navigation;
      DELETE FROM channel_group_entries;
      DELETE FROM message_revisions;
      DELETE FROM table_settings;
      DELETE FROM table_views;
      DELETE FROM chart_definitions;
      DELETE FROM dictionary_entries;
      DELETE FROM table_records;
      DELETE FROM table_fields;
      DELETE FROM messages;
      DELETE FROM channel_activities;
      DELETE FROM operations;
      DELETE FROM channel_invitations;
      DELETE FROM channel_memberships;
      DELETE FROM channel_groups;
      DELETE FROM channels;
      DELETE FROM persons;
    `);

    for (const person of state.persons) {
      this.#database.run(
        `INSERT INTO persons
          (id, display_name, is_operator, created_at, deactivated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          person.id,
          person.displayName,
          person.isOperator ? 1 : 0,
          person.createdAt,
          person.deactivatedAt ?? null,
        ],
      );
    }

    for (const channel of state.channels) {
      this.#database.run(
        `INSERT INTO channels
          (id, type_id, type_version, title, owner_id, created_at, updated_at,
           deleted_at, deleted_by, purged_at, purged_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          channel.id,
          channel.typeId,
          channel.typeVersion,
          channel.title,
          channel.ownerId,
          channel.createdAt,
          channel.updatedAt,
          channel.deletedAt ?? null,
          channel.deletedBy ?? null,
          channel.purgedAt ?? null,
          channel.purgedBy ?? null,
        ],
      );
    }

    for (const membership of state.memberships) {
      this.#database.run(
        `INSERT INTO channel_memberships (channel_id, person_id, role)
         VALUES (?, ?, ?)`,
        [membership.channelId, membership.personId, membership.role],
      );
    }

    for (const invitation of state.invitations) {
      this.#database.run(
        `INSERT INTO channel_invitations
          (id, channel_id, proposed_role, expires_at, created_by, created_at,
           accepted_by, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invitation.id,
          invitation.channelId,
          invitation.proposedRole,
          invitation.expiresAt,
          invitation.createdBy,
          invitation.createdAt,
          invitation.acceptedBy ?? null,
          invitation.acceptedAt ?? null,
        ],
      );
    }

    for (const operation of state.operations) {
      this.#database.run(
        `INSERT INTO operations
          (id, actor_id, origin, action, channel_id, status, changes_json, intent_json,
           result_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operation.id,
          operation.actorId,
          operation.origin,
          operation.action,
          operation.channelId ?? null,
          operation.status,
          JSON.stringify(operation.changes),
          JSON.stringify(operation.intent),
          JSON.stringify(operation.result),
          operation.occurredAt,
        ],
      );
    }

    for (const activity of state.activities) {
      this.#database.run(
        `INSERT INTO channel_activities
          (sequence, id, channel_id, operation_id, kind, actor_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          activity.position,
          activity.id,
          activity.channelId,
          activity.operationId,
          activity.kind,
          activity.actorId,
          activity.occurredAt,
        ],
      );
    }

    for (const event of state.events) {
      if (event.type === 'activity') {
        this.#database.run(
          `INSERT INTO subscription_events
            (position, id, event_type, operation_id, activity_id, channel_id, actor_id, occurred_at)
           VALUES (?, ?, 'activity', ?, ?, ?, ?, ?)`,
          [
            event.position,
            event.id,
            event.activity.operationId,
            event.activity.id,
            event.activity.channelId,
            event.activity.actorId,
            event.activity.occurredAt,
          ],
        );
        continue;
      }
      this.#database.run(
        `INSERT INTO subscription_events
          (position, id, event_type, operation_id, activity_id, channel_id, actor_id, occurred_at)
         VALUES (?, ?, 'operation-result', ?, NULL, ?, ?, ?)`,
        [
          event.position,
          event.id,
          event.operationId,
          event.channelId ?? null,
          event.actorId,
          event.occurredAt,
        ],
      );
    }

    for (const navigation of state.navigation) {
      this.#database.run(
        `INSERT INTO channel_navigation
          (channel_id, person_id, archived_at, muted, pinned, position, last_read_activity_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          navigation.channelId,
          navigation.personId,
          navigation.archivedAt ?? null,
          navigation.muted ? 1 : 0,
          navigation.pinned ? 1 : 0,
          navigation.position,
          navigation.lastReadActivityId ?? null,
        ],
      );
    }

    for (const group of state.channelGroups) {
      this.#database.run(
        `INSERT INTO channel_groups (id, person_id, name, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [group.id, group.personId, group.name, group.position, group.createdAt],
      );
    }

    for (const entry of state.channelGroupEntries) {
      this.#database.run(
        `INSERT INTO channel_group_entries (group_id, channel_id, pinned, position)
         VALUES (?, ?, ?, ?)`,
        [entry.groupId, entry.channelId, entry.pinned ? 1 : 0, entry.position],
      );
    }

    for (const field of state.tableFields) {
      this.#database.run(
        `INSERT INTO table_fields
          (id, channel_id, key, label, type, required, unique_value, default_json,
           target_channel_id, cardinality, version, tombstoned_at, tombstoned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          field.id,
          field.channelId,
          field.key,
          field.label,
          field.type,
          field.required ? 1 : 0,
          field.unique ? 1 : 0,
          field.defaultValue === undefined
            ? null
            : JSON.stringify(field.defaultValue),
          field.targetChannelId ?? null,
          field.cardinality ?? null,
          field.version,
          field.tombstonedAt ?? null,
          field.tombstonedBy ?? null,
        ],
      );
    }

    for (const entry of state.dictionaryEntries) {
      this.#database.run(
        `INSERT INTO dictionary_entries
          (id, channel_id, label, normalized_label, created_by, created_at,
           updated_at, retired_at, retired_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.channelId,
          entry.label,
          entry.normalizedLabel,
          entry.createdBy,
          entry.createdAt,
          entry.updatedAt ?? null,
          entry.retiredAt ?? null,
          entry.retiredBy ?? null,
        ],
      );
    }

    for (const record of state.tableRecords) {
      this.#database.run(
        `INSERT INTO table_records
          (id, channel_id, values_json, field_versions_json, created_by, created_at,
           updated_at, tombstoned_at, tombstoned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.channelId,
          JSON.stringify(record.values),
          JSON.stringify(record.fieldVersions),
          record.createdBy,
          record.createdAt,
          record.updatedAt ?? null,
          record.tombstonedAt ?? null,
          record.tombstonedBy ?? null,
        ],
      );
    }

    for (const setting of state.tableDisplayFields) {
      this.#database.run(
        `INSERT INTO table_settings (channel_id, display_field_id) VALUES (?, ?)`,
        [setting.channelId, setting.displayFieldId ?? null],
      );
    }

    for (const view of state.tableViews) {
      this.#database.run(
        `INSERT INTO table_views
          (id, channel_id, name, visibility, owner_id, definition_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          view.id,
          view.channelId,
          view.name,
          view.visibility,
          view.ownerId,
          JSON.stringify({
            filters: view.filters,
            grouping: view.grouping,
            sorting: view.sorting,
            visibleFieldIds: view.visibleFieldIds,
          }),
          view.createdAt,
        ],
      );
    }

    for (const definition of state.chartDefinitions) {
      this.#database.run(
        `INSERT INTO chart_definitions
          (channel_id, source_channel_id, definition_json, version)
         VALUES (?, ?, ?, ?)`,
        [
          definition.channelId,
          definition.sourceChannelId,
          JSON.stringify({
            aggregations: definition.aggregations,
            filters: definition.filters,
            grouping: definition.grouping,
            presentation: definition.presentation,
          }),
          definition.version,
        ],
      );
    }

    const pendingMessages = [...state.messages];
    const persistedMessageIds = new Set<string>();
    while (pendingMessages.length > 0) {
      const index = pendingMessages.findIndex(
        (message) =>
          message.replyToMessageId === undefined ||
          persistedMessageIds.has(message.replyToMessageId),
      );
      if (index === -1) throw new Error('Message reply target is unavailable');
      const [message] = pendingMessages.splice(index, 1);
      this.#database.run(
        `INSERT INTO messages
          (id, channel_id, author_id, text, record_references_json, reply_to_message_id,
           created_at, tombstoned_at, tombstoned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message!.id,
          message!.channelId,
          message!.authorId,
          message!.text,
          JSON.stringify(message!.recordReferences),
          message!.replyToMessageId ?? null,
          message!.createdAt,
          message!.tombstonedAt ?? null,
          message!.tombstonedBy ?? null,
        ],
      );
      persistedMessageIds.add(message!.id);
    }

    for (const message of state.messages) {
      for (const revision of message.revisions) {
        this.#database.run(
          `INSERT INTO message_revisions (id, message_id, editor_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            revision.id,
            message.id,
            revision.editorId,
            revision.text,
            revision.createdAt,
          ],
        );
      }
    }
  }
  async close(): Promise<void> {
    this.#database.close(false);
  }
}
