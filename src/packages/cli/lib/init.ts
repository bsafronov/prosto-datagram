import { join } from 'node:path';

import { DatagramError } from '../../application/errors';
import type { CliHost } from './host';
import { checkService } from './doctor';
import {
  isUncertainStarter,
  readSetupJournal,
  saveSetupJournal,
  type JournalStarterProgress,
  type SetupJournal,
} from './journal';
import {
  parseProfile,
  profileNamePattern,
  readServiceProfile,
  type LocalServiceProfile,
  type StarterProgress,
} from './profiles';

const defaultProfileName = 'local';

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
type ReadAnswer = () => Promise<string>;

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

function createAnswerReader(host: CliHost): ReadAnswer {
  const answers = lines(host.terminal.input)[Symbol.asyncIterator]();
  return async () => {
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

async function collectAnswers(
  host: CliHost,
  read: ReadAnswer,
  initialProfileName = defaultProfileName,
): Promise<WizardResult> {
  let step = 0;
  let profileName = initialProfileName;
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

async function collectStarterAnswers(
  host: CliHost,
  read: ReadAnswer,
  progress: StarterProgress,
): Promise<
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'apply'; readonly firstItem: string; readonly title?: string }
> {
  if (progress.status !== 'pending') {
    host.terminal.writeOutput('Resume your first Table\nFirst item (or Cancel): ');
    const firstItem = normalized(await read());
    return isCancel(firstItem) ? { kind: 'cancelled' } : { kind: 'apply', firstItem };
  }

  let title = '';
  let step = 0;
  while (true) {
    if (step === 0) {
      host.terminal.writeOutput('Create your first Table\nChannel title (or Cancel): ');
      const answer = normalized(await read());
      if (isCancel(answer)) return { kind: 'cancelled' };
      title = answer;
      step = 1;
      continue;
    }

    host.terminal.writeOutput('First item (or Back/Cancel): ');
    const firstItem = normalized(await read());
    if (isCancel(firstItem)) return { kind: 'cancelled' };
    if (isBack(firstItem)) {
      step = 0;
      continue;
    }
    return { kind: 'apply', title, firstItem };
  }
}

function actionSubjectId(
  receipt: { readonly subject?: { readonly id: string } },
  action: string,
): string {
  if (receipt.subject === undefined) throw new Error(`${action} returned no subject`);
  return receipt.subject.id;
}

async function saveProfile(
  host: CliHost,
  profilePath: string,
  profile: LocalServiceProfile,
): Promise<void> {
  await host.filesystem.writeTextFileAtomic(profilePath, `${JSON.stringify(profile, null, 2)}\n`, {
    mode: 0o600,
  });
}

function resumeCommand(profileName: string): string {
  return `bunx prosto-datagram init --profile ${JSON.stringify(profileName)}`;
}

async function existingSetupName(
  host: CliHost,
  requestedProfileName: string | undefined,
): Promise<string | undefined> {
  if (requestedProfileName !== undefined) {
    if (!profileNamePattern.test(requestedProfileName)) {
      throw new DatagramError('profile.name-invalid', 'Profile name is invalid.', 400);
    }
    const profilePath = join(host.directories.configuration, 'profiles', `${requestedProfileName}.json`);
    return (await host.filesystem.pathExists(profilePath)) ? requestedProfileName : undefined;
  }
  const defaultProfilePath = join(host.directories.configuration, 'default-profile');
  if (!(await host.filesystem.pathExists(defaultProfilePath))) return undefined;
  const name = (await host.filesystem.readTextFile(defaultProfilePath)).trim();
  return profileNamePattern.test(name) ? name : undefined;
}

function journalFromProfile(profile: LocalServiceProfile): SetupJournal {
  return {
    version: 1,
    profileName: profile.name,
    core: profile.setup?.core ?? 'applied',
    starter: profile.setup?.starter ?? { status: 'pending' },
    durableInstall: 'skipped',
  };
}

function normalStarter(progress: JournalStarterProgress): StarterProgress | undefined {
  return isUncertainStarter(progress) ? undefined : progress;
}

function clearFailure(journal: SetupJournal): SetupJournal {
  const { failure: _failure, ...rest } = journal;
  return rest;
}

async function saveProgress(
  host: CliHost,
  profilePath: string,
  profile: LocalServiceProfile,
  journal: SetupJournal,
): Promise<void> {
  await saveSetupJournal(host, journal);
  const starter = normalStarter(journal.starter);
  if (journal.core === 'verified' && starter !== undefined) {
    await saveProfile(host, profilePath, { ...profile, setup: { core: 'verified', starter } });
  }
}

async function confirmReviewedOperation(
  host: CliHost,
  read: ReadAnswer,
  description: string,
): Promise<boolean> {
  host.terminal.writeOutput(`${description}\nApply this reviewed operation? [Y/n]: `);
  const answer = normalized(await read()).toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

async function runExistingSetup(
  host: CliHost,
  read: ReadAnswer,
  profileName: string,
): Promise<void> {
  const command = resumeCommand(profileName);
  let profile: LocalServiceProfile;
  try {
    profile = await readServiceProfile(host, profileName);
  } catch {
    throw new DatagramError(
      'setup.profile-repair-required',
      `Existing setup profile is unreadable. No changes were made. Repair: ${command}`,
      400,
    );
  }
  const profilePath = join(host.directories.configuration, 'profiles', `${profileName}.json`);
  let journalInvalid = false;
  let journal: SetupJournal;
  try {
    journal = (await readSetupJournal(host, profileName)) ?? journalFromProfile(profile);
  } catch {
    journalInvalid = true;
    journal = journalFromProfile(profile);
  }
  const report = await checkService(host, profileName);
  const incomplete =
    journalInvalid ||
    journal.core !== 'verified' ||
    journal.starter.status !== 'complete' ||
    journal.durableInstall === 'pending';
  host.terminal.writeOutput(
    `Existing setup detected for profile ${JSON.stringify(profileName)}.\n` +
      `Core: ${journal.core}; starter: ${journal.starter.status}; Service: ${report.ok ? 'ready' : 'needs repair'}; journal: ${journalInvalid ? 'needs repair' : 'valid'}\n` +
      'Choose reviewed operation:\n' +
      '  1. Inspect only\n' +
      `  2. Resume incomplete stages${incomplete ? ' (Recommended)' : ''}\n` +
      `  3. Repair setup metadata${!report.ok || journalInvalid ? ' (Recommended)' : ''}\n` +
      '  4. Update default profile selection\n' +
      '  5. Cancel\n' +
      `Selection [${journalInvalid ? '3' : incomplete ? '2' : '1'}]: `,
  );
  const rawChoice = normalized(await read());
  const choice = rawChoice === '' ? (journalInvalid ? '3' : incomplete ? '2' : '1') : rawChoice;
  if (choice === '5' || isCancel(choice)) {
    host.terminal.writeOutput('Setup cancelled. No changes were made.\n');
    return;
  }
  if (choice === '1') {
    for (const check of report.checks) host.terminal.writeOutput(`${check.stage}: ${check.status}\n`);
    host.terminal.writeOutput(`No changes made. Resume or repair: ${command}\n`);
    return;
  }
  if (choice === '4') {
    if (!(await confirmReviewedOperation(host, read, `Update only default profile selection to ${JSON.stringify(profileName)}.\nNo Service data or other configuration will change.`))) {
      host.terminal.writeOutput('Update cancelled. No changes were made.\n');
      return;
    }
    await host.filesystem.writeTextFileAtomic(
      join(host.directories.configuration, 'default-profile'),
      `${profileName}\n`,
      { mode: 0o600 },
    );
    host.terminal.writeOutput('Default profile selection updated.\n');
    return;
  }
  if (choice === '3') {
    if (!(await confirmReviewedOperation(host, read, `Repair setup metadata for ${JSON.stringify(profileName)} from verified Doctor facts.\nNo profile, Store, database, Channel, Record, secret, or unrelated configuration will be deleted.`))) {
      host.terminal.writeOutput('Repair cancelled. No changes were made.\n');
      return;
    }
    if (!report.ok) {
      const failure = report.checks.find((check) => check.status === 'failed');
      throw new DatagramError(
        failure?.code ?? 'setup.repair-required',
        `Repair stopped safely; Service failed verification. Repair: ${command}`,
        400,
      );
    }
    journal = { ...clearFailure(journal), core: 'verified' };
    await saveProgress(host, profilePath, profile, journal);
    host.terminal.writeOutput(`Setup metadata repaired. Inspect: bunx prosto-datagram doctor --profile ${JSON.stringify(profileName)}\n`);
    return;
  }
  if (choice !== '2') {
    throw new DatagramError('input.invalid', 'Choose 1, 2, 3, 4, or 5.', 400);
  }
  if (journalInvalid) {
    throw new DatagramError(
      'setup.journal-invalid',
      `Resume stopped safely; setup journal needs reviewed repair. Repair: ${command}`,
      400,
    );
  }
  if (!(await confirmReviewedOperation(host, read, `Resume profile ${JSON.stringify(profileName)} from last verified stage.\nCore will not be repeated. Completed optional effects will not be repeated.`))) {
    host.terminal.writeOutput('Resume cancelled. No changes were made.\n');
    return;
  }
  if (!report.ok) {
    throw new DatagramError('setup.repair-required', `Resume stopped safely; Service needs repair. Repair: ${command}`, 400);
  }
  if (journal.core !== 'verified') {
    journal = { ...clearFailure(journal), core: 'verified' };
    await saveProgress(host, profilePath, profile, journal);
  }
  if (isUncertainStarter(journal.starter)) {
    throw new DatagramError(
      'setup.effect-uncertain',
      `Previous Action may have committed. It was not repeated. Inspect Service before repair. Repair: ${command}`,
      409,
    );
  }
  if (journal.starter.status !== 'complete') {
    const answers = await collectStarterAnswers(host, read, journal.starter);
    if (answers.kind === 'cancelled') {
      host.terminal.writeOutput(`Core setup remains ready. Resume: ${command}\n`);
      return;
    }
    const runtime = await host.openRuntime({ databasePath: profile.service.databasePath });
    let starter: JournalStarterProgress = journal.starter;
    try {
      if (starter.status === 'pending') {
        journal = { ...clearFailure(journal), starter: { status: 'channel-applying' } };
        await saveSetupJournal(host, journal);
        const receipt = await runtime.app.executeAction(profile.identity.personId, 'cli', 'channel.create', {
          title: answers.title,
          typeId: 'table',
        });
        starter = {
          status: 'channel-created',
          channelId: actionSubjectId(receipt, 'channel.create'),
          channelOperationId: receipt.operationId,
        };
        journal = { ...journal, starter };
        await saveProgress(host, profilePath, profile, journal);
      }
      if (starter.status === 'channel-created') {
        journal = { ...journal, starter: { status: 'field-applying', channelId: starter.channelId, channelOperationId: starter.channelOperationId } };
        await saveSetupJournal(host, journal);
        const receipt = await runtime.app.executeAction(profile.identity.personId, 'cli', 'table.field.add', {
          channelId: starter.channelId,
          key: 'name', label: 'Name', required: true, type: 'text', unique: true,
        });
        starter = { ...starter, status: 'field-created', fieldOperationId: receipt.operationId };
        journal = { ...journal, starter };
        await saveProgress(host, profilePath, profile, journal);
      }
      if (starter.status === 'field-created') {
        journal = { ...journal, starter: { status: 'record-applying', channelId: starter.channelId, channelOperationId: starter.channelOperationId, fieldOperationId: starter.fieldOperationId } };
        await saveSetupJournal(host, journal);
        const receipt = await runtime.app.executeAction(profile.identity.personId, 'cli', 'table.record.create', {
          channelId: starter.channelId,
          values: { name: answers.firstItem },
        });
        const completed: StarterProgress = {
          ...starter,
          status: 'complete',
          recordOperationId: receipt.operationId,
        };
        starter = completed;
        journal = { ...clearFailure(journal), starter: completed };
        await saveProgress(host, profilePath, profile, journal);
      }
    } catch {
      journal = {
        ...journal,
        starter,
        failure: { stage: 'starter', code: 'setup.starter-failed' },
      };
      await saveSetupJournal(host, journal);
      throw new DatagramError('setup.starter-failed', `Starter setup failed. Core remains ready. Resume: ${command}`, 500);
    } finally {
      await runtime.close();
    }
  }
  if (journal.durableInstall === 'pending') {
    host.terminal.writeOutput(
      `Resume optional durable command install: ${durableInstallCommand}\nRun it now? [y/N]: `,
    );
    const answer = normalized(await read()).toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      const installed = await host.runExternalCommand({
        command: 'bun',
        args: ['install', '--global', 'prosto-datagram'],
      });
      if (installed.exitCode === 0) {
        journal = { ...clearFailure(journal), durableInstall: 'verified' };
        await saveSetupJournal(host, journal);
      } else {
        journal = {
          ...journal,
          failure: { stage: 'durable-install', code: 'setup.durable-install-failed' },
        };
        await saveSetupJournal(host, journal);
        host.terminal.writeOutput(`Optional install remains pending. Resume: ${command}\n`);
      }
    } else {
      host.terminal.writeOutput(`Optional install remains pending. Resume: ${command}\n`);
    }
  }
  host.terminal.writeOutput(
    journal.durableInstall === 'pending'
      ? `Core setup complete. Optional install remains pending. Resume: ${command}\n`
      : `Setup complete. Profile ${JSON.stringify(profileName)} is ready.\n`,
  );
}

export async function runGuidedInit(host: CliHost, requestedProfileName?: string): Promise<void> {
  if (!host.terminal.inputIsInteractive || !host.terminal.outputIsInteractive) {
    throw new DatagramError(
      'setup.interactive-required',
      '`datagram init` requires an interactive terminal. Open a terminal and run `bunx prosto-datagram init`.',
      400,
    );
  }

  const read = createAnswerReader(host);
  const existingName = await existingSetupName(host, requestedProfileName);
  if (existingName !== undefined) {
    await runExistingSetup(host, read, existingName);
    return;
  }
  host.terminal.writeOutput(
    'Set up Prosto.Datagram\nType Back to revisit a choice or Cancel to exit before Apply.\n',
  );
  const result = await collectAnswers(host, read, requestedProfileName);
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
  let journal: SetupJournal = {
    version: 1,
    profileName: result.profileName,
    core: 'planned',
    starter: { status: 'pending' },
    durableInstall: result.durableInstall === undefined ? 'skipped' : 'pending',
  };
  await saveSetupJournal(host, journal);
  let runtime;
  try {
    runtime = await host.createRuntime({
      databasePath,
      ownerDisplayName: result.displayName,
    });
  } catch {
    journal = { ...journal, failure: { stage: 'core', code: 'setup.core-failed' } };
    await saveSetupJournal(host, journal);
    throw new DatagramError(
      'setup.core-failed',
      `Core setup failed. Resume: ${resumeCommand(result.profileName)}`,
      500,
    );
  }
  let firstChannelId: string | undefined;
  try {
    host.terminal.writeOutput('[2/3] Saving default Service profile\n');
    const existingProfile = (await host.filesystem.pathExists(profilePath))
      ? parseProfile(await host.filesystem.readTextFile(profilePath), result.profileName)
      : undefined;
    let profile: LocalServiceProfile = {
      version: 1,
      name: result.profileName,
      service: { kind: 'local', databasePath },
      identity: { personId: runtime.owner.id, displayName: runtime.owner.displayName },
      ...(existingProfile?.setup === undefined ? {} : { setup: existingProfile.setup }),
    };
    await saveProfile(host, profilePath, profile);
    await host.filesystem.writeTextFileAtomic(defaultProfilePath, `${result.profileName}\n`, { mode: 0o600 });
    journal = { ...journal, core: 'applied' };
    await saveSetupJournal(host, journal);

    host.terminal.writeOutput('[3/3] Verifying profile, Store, runtime, and identity\n');
    const verification = await checkService(host, result.profileName, runtime);
    if (!verification.ok) {
      const failure = verification.checks.find((check) => check.status === 'failed');
      throw new DatagramError(
        failure?.code ?? 'setup.verification-failed',
        failure === undefined
          ? 'Setup verification failed. Run `datagram init` to repair it.'
          : `Setup verification failed at ${failure.stage}. Profile ${JSON.stringify(result.profileName)}. ${failure.recovery}`,
        500,
      );
    }

    let starter = profile.setup?.starter ?? ({ status: 'pending' } as const);
    profile = { ...profile, setup: { core: 'verified', starter } };
    await saveProfile(host, profilePath, profile);
    journal = { ...journal, core: 'verified', starter };
    await saveSetupJournal(host, journal);

    if (starter.status !== 'complete') {
      const answers = await collectStarterAnswers(host, read, starter);
      if (answers.kind === 'cancelled') {
        host.terminal.writeOutput(
          'Core setup complete. Your first Table is still pending.\n' +
            `Resume: ${resumeCommand(result.profileName)}\n`,
        );
        return;
      }

      try {
        if (starter.status === 'pending') {
          journal = { ...journal, starter: { status: 'channel-applying' } };
          await saveSetupJournal(host, journal);
          const receipt = await runtime.app.executeAction(runtime.owner.id, 'cli', 'channel.create', {
            title: answers.title,
            typeId: 'table',
          });
          starter = {
            status: 'channel-created',
            channelId: actionSubjectId(receipt, 'channel.create'),
            channelOperationId: receipt.operationId,
          };
          profile = { ...profile, setup: { core: 'verified', starter } };
          await saveProfile(host, profilePath, profile);
          journal = { ...journal, starter };
          await saveSetupJournal(host, journal);
        }

        if (starter.status === 'channel-created') {
          journal = {
            ...journal,
            starter: {
              status: 'field-applying',
              channelId: starter.channelId,
              channelOperationId: starter.channelOperationId,
            },
          };
          await saveSetupJournal(host, journal);
          const receipt = await runtime.app.executeAction(
            runtime.owner.id,
            'cli',
            'table.field.add',
            {
              channelId: starter.channelId,
              key: 'name',
              label: 'Name',
              required: true,
              type: 'text',
              unique: true,
            },
          );
          starter = {
            status: 'field-created',
            channelId: starter.channelId,
            channelOperationId: starter.channelOperationId,
            fieldOperationId: receipt.operationId,
          };
          profile = { ...profile, setup: { core: 'verified', starter } };
          await saveProfile(host, profilePath, profile);
          journal = { ...journal, starter };
          await saveSetupJournal(host, journal);
        }

        if (starter.status === 'field-created') {
          journal = {
            ...journal,
            starter: {
              status: 'record-applying',
              channelId: starter.channelId,
              channelOperationId: starter.channelOperationId,
              fieldOperationId: starter.fieldOperationId,
            },
          };
          await saveSetupJournal(host, journal);
          const receipt = await runtime.app.executeAction(
            runtime.owner.id,
            'cli',
            'table.record.create',
            { channelId: starter.channelId, values: { name: answers.firstItem } },
          );
          starter = {
            status: 'complete',
            channelId: starter.channelId,
            channelOperationId: starter.channelOperationId,
            fieldOperationId: starter.fieldOperationId,
            recordOperationId: receipt.operationId,
          };
          profile = { ...profile, setup: { core: 'verified', starter } };
          await saveProfile(host, profilePath, profile);
          journal = { ...journal, starter };
          await saveSetupJournal(host, journal);
        }
      } catch {
        journal = {
          ...journal,
          starter,
          failure: { stage: 'starter', code: 'setup.starter-failed' },
        };
        await saveSetupJournal(host, journal);
        host.terminal.writeOutput(
          'Starter Table setup failed. Core setup remains ready.\n' +
            `Resume: ${resumeCommand(result.profileName)}\n`,
        );
        throw new DatagramError(
          'setup.starter-failed',
          `Starter Table setup failed. Core setup remains ready. Resume: ${resumeCommand(result.profileName)}`,
          500,
        );
      }
    }

    firstChannelId = starter.channelId;
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
        journal = { ...clearFailure(journal), durableInstall: 'verified' };
      } else {
        durableInstallStatus = `pending (installer exit code ${installed.exitCode})`;
        journal = {
          ...journal,
          durableInstall: 'pending',
          failure: { stage: 'durable-install', code: 'setup.durable-install-failed' },
        };
      }
    } catch {
      durableInstallStatus = 'pending (installer could not be started)';
      journal = {
        ...journal,
        durableInstall: 'pending',
        failure: { stage: 'durable-install', code: 'setup.durable-install-failed' },
      };
    }
    await saveSetupJournal(host, journal);
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
      `First Channel: ${firstChannelId}\n` +
      `Durable commands: ${durableInstallStatus}\n` +
      `CLI: bunx prosto-datagram actions --profile ${JSON.stringify(result.profileName)}\n` +
      `MCP: DATAGRAM_DB=${JSON.stringify(databasePath)} DATAGRAM_ACTOR_ID=${JSON.stringify(runtime.owner.id)} bunx --package prosto-datagram datagram-mcp\n` +
      'Reconfigure: bunx prosto-datagram init\n',
  );
}
