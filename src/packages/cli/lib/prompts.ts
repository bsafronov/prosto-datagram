import { confirm, isCancel, password, select, text } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

import { DatagramError } from '../../application/errors';
import type { CliHost } from './host';

export interface SetupPrompt {
  readonly message: string;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  readonly initialValue?: string;
  readonly secret?: boolean;
  readonly confirm?: boolean;
}

export type ReadAnswer = (prompt: SetupPrompt) => Promise<string>;

export function createTerminalPrompts(input: Readable, output: Writable): ReadAnswer {
  return async (prompt) => {
    const common = { input, output, message: prompt.message };
    const answer = prompt.choices
      ? await select({ ...common, options: [...prompt.choices], initialValue: prompt.initialValue })
      : prompt.confirm
        ? await confirm({ ...common, initialValue: prompt.initialValue === 'yes' })
        : prompt.secret
          ? await password(common)
          : await text(common);
    if (isCancel(answer)) return 'Cancel';
    if (typeof answer === 'boolean') return answer ? 'yes' : 'no';
    return String(answer);
  };
}

async function* lines(input: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of input) {
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const split = buffered.split(/\r?\n/);
    buffered = split.pop() ?? '';
    for (const line of split) yield line;
  }
  buffered += decoder.decode();
  if (buffered.length > 0) yield buffered;
}

export function createAnswerReader(host: CliHost): ReadAnswer {
  if (host.terminal.prompt) return host.terminal.prompt;
  const answers = lines(host.terminal.input)[Symbol.asyncIterator]();
  return async (prompt) => {
    host.terminal.writeOutput(`${prompt.message}\n`);
    for (const choice of prompt.choices ?? []) {
      host.terminal.writeOutput(`  ${choice.value}. ${choice.label}\n`);
    }
    const result = await answers.next();
    if (result.done) {
      throw new DatagramError(
        'setup.input-ended',
        'Setup input ended. Run `datagram init` in an interactive terminal to try again.',
        400,
      );
    }
    return result.value;
  };
}
