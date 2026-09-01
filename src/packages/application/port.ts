import type {
  ActionReceipt,
  OperationOrigin,
  QueryResult,
  SubscriptionEvent,
} from '../domain/model';
import type { ActionRegistry, QueryRegistry } from './contracts';
import type { ChannelTypeContractSelector } from './contracts';
import type {
  DataViewQueryDefinition,
  IssuedResultHandle,
  ResultHandleBroker,
  ResultHandleComposition,
} from './result-handles';

export interface DatagramApplicationPort {
  readonly actions: ActionRegistry;
  readonly handles: ResultHandleBroker;
  readonly queries: QueryRegistry;
  verifyServiceIdentity(actorId: string): Promise<{ readonly actorId: string }>;
  executeAction(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
    selectedType?: ChannelTypeContractSelector,
  ): Promise<ActionReceipt>;
  executeQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
    selectedType?: ChannelTypeContractSelector,
  ): Promise<QueryResult>;
  prepareQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
    purpose?: string,
    selectedType?: ChannelTypeContractSelector,
  ): Promise<IssuedResultHandle>;
  reopenDataView(
    actorId: string,
    origin: OperationOrigin,
    definition: DataViewQueryDefinition,
  ): Promise<IssuedResultHandle>;
  composeResultHandle(
    actorId: string,
    composition: ResultHandleComposition,
  ): Promise<IssuedResultHandle>;
  consumeResultHandle(
    actorId: string,
    handleId: string,
    purpose: string,
  ): Promise<QueryResult>;
  subscribe(
    actorId: string,
    options?: { readonly after?: number; readonly signal?: AbortSignal },
  ): AsyncIterable<SubscriptionEvent>;
}
