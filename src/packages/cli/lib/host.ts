import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { createRuntime, type DatagramRuntime, type RuntimeOptions } from '../../runtime';
import { startHttpServer, type ServerOptions } from '../../server';

export interface CliTerminal {
  readonly input: AsyncIterable<string | Uint8Array>;
  readonly inputIsInteractive: boolean;
  readonly outputIsInteractive: boolean;
  writeOutput(value: string): void;
  writeError(value: string): void;
}

export interface CliFileSystem {
  pathExists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, value: string, options?: { readonly mode?: number }): Promise<void>;
  makeDirectory(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

export interface CliPlatformDirectories {
  readonly configuration: string;
  readonly data: string;
}

export interface ExternalCommandRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ExternalCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliHttpServer {
  readonly identityMode: 'development' | 'production';
  readonly runtime: DatagramRuntime;
  readonly server: {
    readonly url: URL;
    stop(): void | Promise<void>;
  };
}

export interface CliHost {
  readonly terminal: CliTerminal;
  readonly environment: {
    get(name: string): string | undefined;
  };
  readonly filesystem: CliFileSystem;
  readonly directories: CliPlatformDirectories;
  readonly currentDirectory: string;
  runExternalCommand(request: ExternalCommandRequest): Promise<ExternalCommandResult>;
  createRuntime(options?: RuntimeOptions): Promise<DatagramRuntime>;
  startHttpServer(options?: ServerOptions): Promise<CliHttpServer>;
  onTermination(handler: () => void | Promise<void>): void;
  exit(code: number): void;
  setExitCode(code: number): void;
}

function processDirectories(): CliPlatformDirectories {
  const homeDirectory = homedir();
  if (platform() === 'darwin') {
    const applicationSupport = join(homeDirectory, 'Library', 'Application Support', 'Prosto.Datagram');
    return { configuration: applicationSupport, data: applicationSupport };
  }
  return {
    configuration: join(process.env.XDG_CONFIG_HOME ?? join(homeDirectory, '.config'), 'prosto-datagram'),
    data: join(process.env.XDG_DATA_HOME ?? join(homeDirectory, '.local', 'share'), 'prosto-datagram'),
  };
}

export function createProcessCliHost(): CliHost {
  return {
    terminal: {
      input: process.stdin,
      inputIsInteractive: process.stdin.isTTY,
      outputIsInteractive: process.stdout.isTTY,
      writeOutput: (value) => process.stdout.write(value),
      writeError: (value) => process.stderr.write(value),
    },
    environment: { get: (name) => process.env[name] },
    filesystem: {
      pathExists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      readTextFile: (path) => readFile(path, 'utf8'),
      writeTextFile: (path, value, options) => writeFile(path, value, options),
      makeDirectory: (path, options) => mkdir(path, options).then(() => undefined),
    },
    directories: processDirectories(),
    currentDirectory: process.cwd(),
    runExternalCommand: async ({ command, args = [], cwd, environment }) => {
      const child = Bun.spawn([command, ...args], {
        ...(cwd === undefined ? {} : { cwd }),
        env: environment === undefined ? process.env : { ...process.env, ...environment },
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      return { exitCode, stderr, stdout };
    },
    createRuntime,
    startHttpServer,
    onTermination: (handler) => {
      process.once('SIGINT', handler);
      process.once('SIGTERM', handler);
    },
    exit: (code) => process.exit(code),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}
