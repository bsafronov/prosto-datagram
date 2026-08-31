import type {
  Channel,
  ChannelActivity,
  ChannelGroup,
  ChannelGroupEntry,
  ChannelInvitation,
  ChannelListItem,
  ChannelMembership,
  ChannelNavigation,
  DictionaryEntry,
  Message,
  Operation,
  Person,
  TableField,
  TableRecord,
  TableView,
} from '../../domain/model';

export interface DatagramStore {
  close(): Promise<void>;
  commit(operation: Operation): Promise<void>;
  ensureLocalOwner(displayName?: string): Promise<Person>;
  getActivity(activityId: string): Promise<ChannelActivity | null>;
  getChannel(channelId: string): Promise<Channel | null>;
  getChannelGroup(groupId: string): Promise<ChannelGroup | null>;
  getChannelNavigation(channelId: string, personId: string): Promise<ChannelNavigation>;
  getDictionaryEntry(entryId: string): Promise<DictionaryEntry | null>;
  getInvitation(invitationId: string): Promise<ChannelInvitation | null>;
  getMessage(messageId: string): Promise<Message | null>;
  getMembership(channelId: string, personId: string): Promise<ChannelMembership | null>;
  getPerson(personId: string): Promise<Person | null>;
  getTableDisplayFieldId(channelId: string): Promise<string | null>;
  getTableRecord(recordId: string): Promise<TableRecord | null>;
  initialize(): Promise<void>;
  listChannels(personId: string): Promise<readonly Channel[]>;
  listOwnedChannels(personId: string): Promise<readonly Channel[]>;
  listActivities(channelId: string): Promise<readonly ChannelActivity[]>;
  listChannelGroupEntries(groupId: string): Promise<readonly ChannelGroupEntry[]>;
  listChannelGroups(personId: string): Promise<readonly ChannelGroup[]>;
  listChannelNavigation(personId: string): Promise<readonly ChannelListItem[]>;
  listDictionaryEntries(channelId: string): Promise<readonly DictionaryEntry[]>;
  listMessages(channelId: string): Promise<readonly Message[]>;
  listOperations(channelId: string): Promise<readonly Operation[]>;
  listServiceOperations(): Promise<readonly Operation[]>;
  listTableFields(channelId: string): Promise<readonly TableField[]>;
  listTableRecords(channelId: string): Promise<readonly TableRecord[]>;
  listTableViews(channelId: string, personId: string): Promise<readonly TableView[]>;
}
