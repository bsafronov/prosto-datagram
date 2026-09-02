import { join } from 'node:path';

import { DatagramError } from '../../application/errors';

export type NativeCredentialProviderKind = 'macos-keychain' | 'linux-secret-service';

export type NativeCredentialReference = {
  readonly kind: 'native';
  readonly provider: NativeCredentialProviderKind;
  readonly service: 'prosto-datagram';
  readonly account: string;
};

export type CredentialReference =
  | NativeCredentialReference
  | { readonly kind: 'file'; readonly path: string; readonly key: string }
  | { readonly kind: 'environment'; readonly name: string };

export type CredentialProviderAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface CredentialProvider {
  readonly kind: NativeCredentialProviderKind;
  availability(): Promise<CredentialProviderAvailability>;
  create(input: { readonly account: string; readonly label: string; readonly secret: string }): Promise<NativeCredentialReference>;
  resolve(reference: NativeCredentialReference): Promise<string>;
  update(reference: NativeCredentialReference, secret: string): Promise<void>;
}

export interface CredentialCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface CredentialCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CredentialCommandRunner = (
  request: CredentialCommandRequest,
) => Promise<CredentialCommandResult>;

const service = 'prosto-datagram' as const;

function providerFailure(code: string, message: string): DatagramError {
  return new DatagramError(code, message, 500);
}

abstract class CommandCredentialProvider implements CredentialProvider {
  abstract readonly kind: NativeCredentialProviderKind;
  protected constructor(protected readonly run: CredentialCommandRunner) {}
  abstract availability(): Promise<CredentialProviderAvailability>;
  abstract create(input: { readonly account: string; readonly label: string; readonly secret: string }): Promise<NativeCredentialReference>;
  abstract resolve(reference: NativeCredentialReference): Promise<string>;
  abstract update(reference: NativeCredentialReference, secret: string): Promise<void>;

  protected requireReference(reference: NativeCredentialReference): void {
    if (reference.provider !== this.kind || reference.service !== service || !reference.account) {
      throw new DatagramError(
        'credential.reference-invalid',
        'Credential reference does not belong to the selected native provider.',
        400,
      );
    }
  }
}

class MacosKeychainProvider extends CommandCredentialProvider {
  readonly kind = 'macos-keychain' as const;

  constructor(run: CredentialCommandRunner, private readonly helperPath: string) {
    super(run);
  }

  private command(operation: string, account?: string, secret?: string) {
    return this.run({
      command: '/usr/bin/xcrun',
      args: ['swift', this.helperPath, operation, service, ...(account ? [account] : [])],
      ...(secret === undefined ? {} : { stdin: secret }),
    });
  }

  async availability(): Promise<CredentialProviderAvailability> {
    try {
      const result = await this.command('availability');
      return result.exitCode === 0
        ? { available: true }
        : { available: false, reason: 'macOS Keychain is unavailable or locked.' };
    } catch {
      return { available: false, reason: 'macOS Keychain support requires the system Swift runtime.' };
    }
  }

  async create(input: { readonly account: string; readonly label: string; readonly secret: string }): Promise<NativeCredentialReference> {
    const result = await this.command('create', input.account, input.secret);
    if (result.exitCode !== 0) {
      throw providerFailure('credential.native-create-failed', 'Credential could not be saved in macOS Keychain.');
    }
    return { kind: 'native', provider: this.kind, service, account: input.account };
  }

  async resolve(reference: NativeCredentialReference): Promise<string> {
    this.requireReference(reference);
    const result = await this.command('resolve', reference.account);
    if (result.exitCode !== 0 || result.stdout.length === 0) {
      throw providerFailure('credential.native-resolve-failed', 'Credential could not be resolved from macOS Keychain.');
    }
    return result.stdout;
  }

  async update(reference: NativeCredentialReference, secret: string): Promise<void> {
    this.requireReference(reference);
    const result = await this.command('update', reference.account, secret);
    if (result.exitCode !== 0) {
      throw providerFailure('credential.native-update-failed', 'Credential could not be updated in macOS Keychain.');
    }
  }
}

class LinuxSecretServiceProvider extends CommandCredentialProvider {
  readonly kind = 'linux-secret-service' as const;

  constructor(run: CredentialCommandRunner) {
    super(run);
  }

  private command(args: readonly string[], secret?: string) {
    return this.run({
      command: 'secret-tool',
      args,
      ...(secret === undefined ? {} : { stdin: secret }),
    });
  }

  async availability(): Promise<CredentialProviderAvailability> {
    try {
      const client = await this.command(['--help']);
      if (client.exitCode !== 0) {
        return { available: false, reason: 'Linux Secret Service client is not installed.' };
      }
      const result = await this.run({
        command: 'gdbus',
        args: [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.secrets',
          '--object-path',
          '/org/freedesktop/secrets',
          '--method',
          'org.freedesktop.DBus.Peer.Ping',
        ],
      });
      return result.exitCode === 0
        ? { available: true }
        : { available: false, reason: 'Linux Secret Service has no usable unlocked user session.' };
    } catch {
      return { available: false, reason: 'Linux Secret Service client is not installed.' };
    }
  }

  async create(input: { readonly account: string; readonly label: string; readonly secret: string }): Promise<NativeCredentialReference> {
    const result = await this.command(
      ['store', `--label=${input.label}`, 'application', service, 'account', input.account],
      input.secret,
    );
    if (result.exitCode !== 0) {
      throw providerFailure('credential.native-create-failed', 'Credential could not be saved in Linux Secret Service.');
    }
    return { kind: 'native', provider: this.kind, service, account: input.account };
  }

  async resolve(reference: NativeCredentialReference): Promise<string> {
    this.requireReference(reference);
    const result = await this.command(['lookup', 'application', service, 'account', reference.account]);
    if (result.exitCode !== 0 || result.stdout.length === 0) {
      throw providerFailure('credential.native-resolve-failed', 'Credential could not be resolved from Linux Secret Service.');
    }
    return result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  }

  async update(reference: NativeCredentialReference, secret: string): Promise<void> {
    this.requireReference(reference);
    const existing = await this.command(['lookup', 'application', service, 'account', reference.account]);
    if (existing.exitCode !== 0) {
      throw providerFailure('credential.native-update-failed', 'Credential could not be updated in Linux Secret Service.');
    }
    const result = await this.command(
      ['store', '--label=Prosto.Datagram credential', 'application', service, 'account', reference.account],
      secret,
    );
    if (result.exitCode !== 0) {
      throw providerFailure('credential.native-update-failed', 'Credential could not be updated in Linux Secret Service.');
    }
  }
}

export function createNativeCredentialProvider(
  operatingSystem: NodeJS.Platform,
  run: CredentialCommandRunner,
): CredentialProvider | undefined {
  if (operatingSystem === 'darwin') {
    return new MacosKeychainProvider(run, join(import.meta.dir, '..', 'native', 'macos-keychain.swift'));
  }
  if (operatingSystem === 'linux') return new LinuxSecretServiceProvider(run);
  return undefined;
}
