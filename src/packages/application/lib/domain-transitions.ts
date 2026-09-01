import type { DomainChange, JsonValue, Message, TableRecord } from '../../domain/model';

type RecordUpdate = Extract<DomainChange, { readonly kind: 'table.record-updated' }>;

export function applyTableRecordUpdate(
  record: TableRecord,
  change: RecordUpdate,
): TableRecord {
  const values = { ...record.values };
  const fieldVersions = { ...record.fieldVersions };
  for (const [key, expected] of Object.entries(change.expectedVersions ?? {})) {
    if ((fieldVersions[key] ?? 0) !== expected) {
      throw new Error(`Table Field value changed after observation: ${key}`);
    }
  }
  const changedKeys = new Set([...Object.keys(change.values), ...(change.removedKeys ?? [])]);
  Object.assign(values, change.values);
  for (const key of change.removedKeys ?? []) delete values[key];
  for (const key of changedKeys) fieldVersions[key] = (fieldVersions[key] ?? 0) + 1;
  return { ...record, fieldVersions, updatedAt: change.updatedAt, values };
}

export function validatePostedMessage(
  message: Message,
  replyTargetChannelId?: string,
): void {
  if (message.revisions.length !== 1) {
    throw new Error('Posted Message must have exactly one initial revision');
  }
  const revision = message.revisions[0]!;
  if (revision.editorId !== message.authorId || revision.text !== message.text) {
    throw new Error('Initial Message revision must match posted Message');
  }
  if (message.replyToMessageId !== undefined && replyTargetChannelId !== message.channelId) {
    throw new Error('Reply target must belong to the same Channel Discussion');
  }
}

export function parseRecordState(
  recordId: string,
  channelId: string,
  createdBy: string,
  createdAt: string,
  valuesJson: string,
  fieldVersionsJson: string,
): TableRecord {
  return {
    channelId,
    createdAt,
    createdBy,
    fieldVersions: JSON.parse(fieldVersionsJson) as Record<string, number>,
    id: recordId,
    values: JSON.parse(valuesJson) as Record<string, JsonValue>,
  };
}
