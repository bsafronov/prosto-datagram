import { bundledChannelTypes, ChannelTypeRegistry } from '../domain/channel-types';
import { DatagramApplication } from './lib/datagram';
import type { DatagramStore } from './store';

export { DatagramApplication } from './lib/datagram';

export function createDatagramApplication(store: DatagramStore): DatagramApplication {
  return new DatagramApplication(store, new ChannelTypeRegistry(bundledChannelTypes));
}
