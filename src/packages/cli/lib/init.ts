import { join } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { CliHost } from './host';

const defaultProfileName = 'local';
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface LocalServiceProfile {
  readonly version: 1;
  readonly name: string;
  readonly service: {
    readonly kind: 'local';
    readonly databasePath: string;
  };
  readonly identity: {
    readonly personId: string;
    readonly displayName: string;
  };
}

type WizardResult =
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'apply';
      readonly profileName: string;
      readonly displayName: string;
      readonly durableInstall: DurableInstallPlan | undefined;
    };

interface DurableInstallPlan {
  readonly command: 'bun';
  readonly args: readonly ['install', '--global', 'prosto-datagram'];
  readonly executablePaths: readonly [string, string];
}

const durableInstallCommand = 'bun install --global prosto-datagram';

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

function normalized(value: string): string {
  return value.trim();
}

function isCancel(value: string): boolean {
  return normalized(value).toLowerCase() === 'cancel';
}

function isBack(value: string): boolean {
  return normalized(value).toLowerCase() === 'back';
}

async function collectAnswers(host: CliHost): Promise<WizardResult> {
  const answers = lines(host.terminal.input)[Symbol.asyncIterator]();
  const read = async (): Promise<string> => {
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

  let step = 0;
  let profileName = defaultProfileName;
  let displayName = '';
  let durableInstall: DurableInstallPlan | undefined;
  while (true) {
    if (step === 0) {
      host.terminal.writeOutput(
        '[1/5] Choose how to use Datagram\n' +
          '  1. Use on this machine (Recommended)\n' +
          '  2. Run for a team\n' +
          'Selection [1] (or Cancel): ',
      );
      const answer = normalized(await read());
      if (isCancel(answer)) return { kind: 'cancelled' };
      if (answer === '' || answer === '1') {
        step = 1;
      } else if (answer === '2') {
        host.terminal.writeOutput(
          'Team setup is not available in this release. Choose “Use on this machine.”\n',
        );
      } else {
        host.terminal.writeOutput('Choose 1 or 2.\n');
      }
      continue;
    }

    if (step === 1) {
      host.terminal.writeOutput(
        `[2/5] Name this Service profile\nProfile name [${profileName}] (or Back/Cancel): `,
      );
      const answer = normalized(await read());
      if (isCancel(answer)) return { kind: 'cancelled' };
      if (isBack(answer)) {
        step = 0;
      } else {
        const candidate = answer === '' ? profileName : answer;
        if (!profileNamePattern.test(candidate)) {
          host.terminal.writeOutput(
            'Use 1-64 letters, numbers, periods, underscores, or hyphens; start with a letter or number.\n',
          );
        } else {
          profileName = candidate;
          step = 2;
        }
      }
      continue;
    }

    if (step === 2) {
      host.terminal.writeOutput(
        '[3/5] Identify the Deployment Operator\nDisplay name (or Back/Cancel): ',
      );
      const answer = normalized(await read());
      if (isCancel(answer)) return { kind: 'cancelled' };
      if (isBack(answer)) {
        step = 1;
      } else if (answer.length === 0 || answer.length > 120) {
        host.terminal.writeOutput('Enter a display name between 1 and 120 characters.\n');
      } else {
        displayName = answer;
        step = 3;
      }
      continue;
    }

    if (step === 3) {
      host.terminal.writeOutput(
        '[4/5] Choose command access\n' +
          'Install durable global `datagram` and `datagram-mcp` commands? [y/N] (or Back/Cancel): ',
      );
      const answer = normalized(await read()).toLowerCase();
      if (isCancel(answer)) return { kind: 'cancelled' };
      if (isBack(answer)) {
        step = 2;
      } else if (answer === '' || answer === 'n' || answer === 'no') {
        durableInstall = undefined;
        step = 4;
      } else if (answer === 'y' || answer === 'yes') {
        const bin = await host.runExternalCommand({ command: 'bun', args: ['pm', 'bin', '-g'] });
        const binDirectory = bin.stdout.trim();
        if (bin.exitCode !== 0 || binDirectory.length === 0) {
          host.terminal.writeOutput(
            'Bun global executable location is unavailable. Choose No and use package-runner commands.\n',
          );
        } else {
          durableInstall = {
            command: 'bun',
            args: ['install', '--global', 'prosto-datagram'],
            executablePaths: [join(binDirectory, 'datagram'), join(binDirectory, 'datagram-mcp')],
          };
          step = 4;
        }
      } else {
        host.terminal.writeOutput('Choose y, N, Back, or Cancel.\n');
      }
      continue;
    }

    const databasePath = join(host.directories.data, 'profiles', profileName, 'datagram.sqlite');
    const profilePath = join(host.directories.configuration, 'profiles', `${profileName}.json`);
    host.terminal.writeOutput(
      '[5/5] Review plan\n' +
        `  Service: Local Service\n  Profile: ${profileName} (default)\n` +
        `  Configuration: ${profilePath}\n  SQLite data: ${databasePath}\n` +
        `  Deployment Operator: ${displayName}\n  Secrets: none\n` +
        (durableInstall === undefined
          ? '  Durable commands: skipped; use bunx package-runner commands\n'
          : `  Durable install command: ${durableInstallCommand}\n` +
            `  Executables: ${durableInstall.executablePaths.join(', ')}\n`) +
        'Apply this plan? [Y/n] (or Back/Cancel): ',
    );
    const answer = normalized(await read()).toLowerCase();
    if (isCancel(answer) || answer === 'n' || answer === 'no') return { kind: 'cancelled' };
    if (isBack(answer)) {
      step = 3;
    } else if (answer === '' || answer === 'y' || answer === 'yes') {
      return { kind: 'apply', profileName, displayName, durableInstall };
    } else {
      host.terminal.writeOutput('Choose Y, n, Back, or Cancel.\n');
    }
  }
}

function parseProfile(value: string): LocalServiceProfile {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('service' in parsed) ||
    typeof parsed.service !== 'object' ||
    parsed.service === null ||
    !('databasePath' in parsed.service) ||
    typeof parsed.service.databasePath !== 'string' ||
    !('identity' in parsed) ||
    typeof parsed.identity !== 'object' ||
    parsed.identity === null ||
    !('personId' in parsed.identity) ||
    typeof parsed.identity.personId !== 'string'
  ) {
    throw new Error('Profile verification failed');
  }
  return parsed as LocalServiceProfile;
}

export async function runGuidedInit(host: CliHost): Promise<void> {
  if (!host.terminal.inputIsInteractive || !host.terminal.outputIsInteractive) {
    throw new DatagramError(
      'setup.interactive-required',
      '`datagram init` requires an interactive terminal. Open a terminal and run `bunx prosto-datagram init`.',
      400,
    );
  }

  host.terminal.writeOutput(
    'Set up Prosto.Datagram\nType Back to revisit a choice or Cancel to exit before Apply.\n',
  );
  const result = await collectAnswers(host);
  if (result.kind === 'cancelled') {
    host.terminal.writeOutput('Setup cancelled. No changes were made.\n');
    return;
  }

  const profileDirectory = join(host.directories.configuration, 'profiles');
  const dataDirectory = join(host.directories.data, 'profiles', result.profileName);
  const profilePath = join(profileDirectory, `${result.profileName}.json`);
  const defaultProfilePath = join(host.directories.configuration, 'default-profile');
  const databasePath = join(dataDirectory, 'datagram.sqlite');

  host.terminal.writeOutput('[1/3] Creating Local Service\n');
  await host.filesystem.makeDirectory(profileDirectory, { recursive: true });
  await host.filesystem.makeDirectory(dataDirectory, { recursive: true });
  const runtime = await host.createRuntime({
    databasePath,
    ownerDisplayName: result.displayName,
  });
  try {
    host.terminal.writeOutput('[2/3] Saving default Service profile\n');
    const profile: LocalServiceProfile = {
      version: 1,
      name: result.profileName,
      service: { kind: 'local', databasePath },
      identity: { personId: runtime.owner.id, displayName: runtime.owner.displayName },
    };
    await host.filesystem.writeTextFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, {
      mode: 0o600,
    });
    await host.filesystem.writeTextFile(defaultProfilePath, `${result.profileName}\n`, { mode: 0o600 });

    host.terminal.writeOutput('[3/3] Verifying profile, Store, runtime, and identity\n');
    if (!(await host.filesystem.pathExists(databasePath))) {
      throw new Error('SQLite Store verification failed');
    }
    const savedProfile = parseProfile(await host.filesystem.readTextFile(profilePath));
    if (
      savedProfile.service.databasePath !== databasePath ||
      savedProfile.identity.personId !== runtime.owner.id
    ) {
      throw new Error('Profile verification failed');
    }
    await runtime.app.verifyServiceIdentity(runtime.owner.id);
    if (runtime.app.actions.catalog().length === 0) throw new Error('Runtime verification failed');

  } finally {
    await runtime.close();
  }

  let durableInstallStatus = 'skipped';
  if (result.durableInstall !== undefined) {
    host.terminal.writeOutput('[optional] Installing durable global commands\n');
    try {
      const installed = await host.runExternalCommand({
        command: result.durableInstall.command,
        args: result.durableInstall.args,
      });
      if (installed.exitCode === 0) {
        durableInstallStatus = `installed (${result.durableInstall.executablePaths.join(', ')})`;
      } else {
        durableInstallStatus = `pending (installer exit code ${installed.exitCode})`;
      }
    } catch {
      durableInstallStatus = 'pending (installer could not be started)';
    }
    if (durableInstallStatus.startsWith('pending')) {
      host.terminal.writeOutput(
        `Optional global installation failed. Core Service remains ready.\nResume optional installation: ${durableInstallCommand}\n`,
      );
    }
  }

  host.terminal.writeOutput(
    'Setup complete.\n' +
      `Profile: ${result.profileName} (default)\nService: Local Service (ready)\n` +
      `Configuration: ${profilePath}\nSQLite data: ${databasePath}\n` +
      `Identity: ${runtime.owner.displayName} (${runtime.owner.id})\n` +
      `Durable commands: ${durableInstallStatus}\n` +
      `CLI: bunx prosto-datagram actions --db ${JSON.stringify(databasePath)}\n` +
      `MCP: DATAGRAM_DB=${JSON.stringify(databasePath)} DATAGRAM_ACTOR_ID=${JSON.stringify(runtime.owner.id)} bunx --package prosto-datagram datagram-mcp\n` +
      'Reconfigure: bunx prosto-datagram init\n',
  );
}
