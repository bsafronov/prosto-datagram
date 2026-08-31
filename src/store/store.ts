import type {
  Channel,
  ChannelMembership,
  Message,
  Operation,
  Person,
  TableField,
  TableRecord,
} from '../domain/model';

export interface DatagramStore {
  close(): Promise<void>;
  commit(operation: Operation): Promise<void>;
  ensureLocalOwner(displayName?: string): Promise<Person>;
  getChannel(channelId: string): Promise<Channel | null>;
  getMembership(channelId: string, personId: string): Promise<ChannelMembership | null>;
  getPerson(personId: string): Promise<Person | null>;
  initialize(): Promise<void>;
  listChannels(personId: string): Promise<readonly Channel[]>;
  listMessages(channelId: string): Promise<readonly Message[]>;
  listOperations(channelId: string): Promise<readonly Operation[]>;
  listTableFields(channelId: string): Promise<readonly TableField[]>;
  listTableRecords(channelId: string): Promise<readonly TableRecord[]>;
}
