import { ZodError } from 'zod';

import { DatagramError } from '../domain/errors';

export { DatagramError };

export interface PublicErrorResult {
  readonly body: {
    readonly error: {
      readonly code: string;
      readonly issues?: readonly {
        readonly code: string;
        readonly message: string;
        readonly path: readonly (number | string)[];
      }[];
      readonly message: string;
    };
  };
  readonly status: number;
}

export function toPublicError(error: unknown): PublicErrorResult {
  if (error instanceof DatagramError) {
    return {
      body: { error: { code: error.code, message: error.message } },
      status: error.status,
    };
  }
  if (error instanceof ZodError) {
    return {
      body: {
        error: {
          code: 'input.invalid',
          issues: error.issues.map(({ code, message, path }) => ({
            code,
            message,
            path: path.map((segment) =>
              typeof segment === 'symbol' ? String(segment) : segment,
            ),
          })),
          message: 'Invalid input',
        },
      },
      status: 400,
    };
  }
  return {
    body: { error: { code: 'internal', message: 'Internal server error' } },
    status: 500,
  };
}
