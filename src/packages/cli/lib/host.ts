import { access, chmod, lstat, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { SQL } from 'bun';

import {
  createRuntime,
  openRuntime,
  type DatagramRuntime,
  type OpenDatagramRuntime,
  type RuntimeOptions,
} from '../../runtime';
import {
  startHttpServer,
  startServerService,
  type ServerOptions,
  type ServerServiceOptions,
} from '../../server';

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
  writeTextFileAtomic(path: string, value: string, options?: { readonly mode?: number }): Promise<void>;
  makeDirectory(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  writePrivateTextFile?(path: string, value: string): Promise<void>;
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
  openRuntime(options?: Pick<RuntimeOptions, 'databasePath'>): Promise<OpenDatagramRuntime>;
  startHttpServer(options?: ServerOptions): Promise<CliHttpServer>;
  probePostgres?(connectionString: string): Promise<void>;
  checkPort?(hostname: string, port: number): Promise<void>;
  startServerService?(options: ServerServiceOptions): ReturnType<typeof startServerService>;
  request?(request: Request): Promise<Response>;
  onTermination(handler: () => void | Promise<void>): void;
  exit(code: number): void;
  setExitCode(code: number): void;
}

export function resolvePlatformDirectories(
  operatingSystem: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): CliPlatformDirectories {
  if (operatingSystem === 'darwin') {
    const applicationSupport = join(homeDirectory, 'Library', 'Application Support', 'Prosto.Datagram');
    return { configuration: applicationSupport, data: applicationSupport };
  }
  if (operatingSystem !== 'linux') {
    throw new Error(`Unsupported operating system: ${operatingSystem}`);
  }
  return {
    configuration: join(environment.XDG_CONFIG_HOME ?? join(homeDirectory, '.config'), 'prosto-datagram'),
    data: join(environment.XDG_DATA_HOME ?? join(homeDirectory, '.local', 'share'), 'prosto-datagram'),
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
      writeTextFileAtomic: async (path, value, options) => {
        const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
        await writeFile(temporaryPath, value, options);
        await rename(temporaryPath, path);
      },
      makeDirectory: (path, options) => mkdir(path, options).then(() => undefined),
      writePrivateTextFile: async (path, value) => {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        await chmod(dirname(path), 0o700);
        try {
          if ((await lstat(path)).isSymbolicLink()) throw new Error('Secret file cannot be a symlink');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
        const file = await open(temporaryPath, 'wx', 0o600);
        try {
          await file.writeFile(value, 'utf8');
        } finally {
          await file.close();
        }
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
        const metadata = await stat(path);
        if ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.()) {
          throw new Error('Secret file owner or permissions are unsafe');
        }
      },
    },
    directories: resolvePlatformDirectories(platform(), homedir(), process.env),
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
    openRuntime,
    startHttpServer,
    probePostgres: async (connectionString) => {
      const client = new SQL(connectionString);
      try {
        await client`SELECT 1`;
      } finally {
        await client.close();
      }
    },
    checkPort: (hostname, port) =>
      new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, hostname, () => server.close((error) => (error ? reject(error) : resolve())));
      }),
    startServerService,
    request: (request) => fetch(request),
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
