import { bundledChannelTypes, ChannelTypeRegistry } from '../domain/channel-types';
import { DatagramApplication } from './lib/datagram';
import type { DatagramStore } from './store';

export { DatagramApplication } from './lib/datagram';
export type {
  AgentViewMetadata,
  DataViewQueryDefinition,
  IssuedResultHandle,
  ResultAggregation,
  ResultFilter,
  ResultHandleComposition,
  ResultHandleTransform,
} from './lib/result-handles';
export { resultHandleCompositionSchema } from './lib/result-handles';

export function createDatagramApplication(store: DatagramStore): DatagramApplication {
  return new DatagramApplication(store, new ChannelTypeRegistry(bundledChannelTypes));
}
