import { DatagramError } from '../../domain/errors';
import type { QueryResult } from '../../domain/model';
import { newId } from '../../domain/model';

interface HandleEntry {
  readonly actorId: string;
  readonly expiresAt: number;
  readonly purpose: string;
  readonly result: QueryResult;
}

export interface IssuedResultHandle {
  readonly expiresAt: string;
  readonly id: string;
  readonly purpose: string;
  readonly view: QueryResult['view'];
}

export class ResultHandleBroker {
  readonly #entries = new Map<string, HandleEntry>();

  constructor(readonly ttlMilliseconds = 5 * 60 * 1000) {}

  issue(actorId: string, purpose: string, result: QueryResult): IssuedResultHandle {
    const id = newId('result');
    const expiresAt = Date.now() + this.ttlMilliseconds;
    this.#entries.set(id, { actorId, expiresAt, purpose, result });
    return {
      expiresAt: new Date(expiresAt).toISOString(),
      id,
      purpose,
      view: { ...result.view, title: purpose },
    };
  }

  consume(actorId: string, handleId: string, purpose: string): QueryResult {
    const entry = this.#entries.get(handleId);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.#entries.delete(handleId);
      throw new DatagramError('result-handle.expired', 'Result Handle is missing or expired', 404);
    }
    if (entry.actorId !== actorId || entry.purpose !== purpose) {
      throw new DatagramError('result-handle.forbidden', 'Result Handle cannot be used here', 403);
    }
    return entry.result;
  }
}
