import type { ActionReceipt, OperationOrigin, QueryResult } from '../domain/model';
import type { ActionRegistry, QueryRegistry } from './contracts';
import type { IssuedResultHandle, ResultHandleBroker } from './result-handles';

export interface DatagramApplicationPort {
  readonly actions: ActionRegistry;
  readonly handles: ResultHandleBroker;
  readonly queries: QueryRegistry;
  executeAction(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<ActionReceipt>;
  executeQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<QueryResult>;
  prepareQuery(
    actorId: string,
    origin: OperationOrigin,
    name: string,
    input: unknown,
  ): Promise<IssuedResultHandle>;
}
