import * as z from 'zod/v4';

export interface ChannelContract<TInput = unknown> {
  readonly inputSchema: z.ZodType<TInput>;
  readonly name: string;
}

export const contract = <TInput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
): ChannelContract<TInput> => ({ inputSchema, name });

export const channelIdSchema = z.string().min(1);

export const channelCreateContract = contract('channel.create', z.object({
  title: z.string().trim().min(1).max(160),
  typeId: z.string().min(1),
}));
