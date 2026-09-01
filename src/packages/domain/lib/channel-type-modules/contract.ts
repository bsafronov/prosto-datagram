import * as z from 'zod/v4';
import type { Operation } from '../model';

export interface ChannelContract<TInput = unknown> {
  readonly inputSchema: z.ZodType<TInput>;
  readonly name: string;
}

export interface ChannelStateRule {
  readonly name: string;
  readonly validate: (contract: string, input: unknown) => void;
  readonly validateTransition?: (operation: Operation) => void;
}

export const contract = <TInput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
): ChannelContract<TInput> => ({ inputSchema, name });

export const channelIdSchema = z.string().min(1);

export const stateRule = (
  name: string,
  validate: ChannelStateRule['validate'],
  validateTransition?: ChannelStateRule['validateTransition'],
): ChannelStateRule => ({ name, validate, ...(validateTransition ? { validateTransition } : {}) });

export const channelCreateContract = contract('channel.create', z.object({
  title: z.string().trim().min(1).max(160),
  typeId: z.string().min(1),
}));
