import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CliHost, ExternalCommandResult } from './host';

const skillFiles = ['SKILL.md', join('agents', 'openai.yaml')] as const;
const manifestName = '.datagram-install.json';

export type CodexComponentStatus = 'pending' | 'verified';

export interface CodexIntegrationProgress {
  readonly skill: CodexComponentStatus;
  readonly mcp: CodexComponentStatus;
}

export type CodexIntegrationDiscovery =
  | {
      readonly available: false;
      readonly reason: string;
    }
  | {
      readonly available: true;
      readonly plan: CodexIntegrationPlan;
    };

export interface CodexIntegrationPlan {
  readonly profileName: string;
  readonly skillSource: string;
  readonly skillDestination: string;
  readonly mcpServerName: string;
  readonly command: 'datagram-mcp';
  readonly args: readonly ['--profile', string];
  readonly credentialReference: 'selected Service profile identity (redacted)';
}

export interface CodexIntegrationResult {
  readonly status: 'verified' | 'partial';
  readonly progress: CodexIntegrationProgress;
  readonly summary: string;
  readonly recovery?: string;
}

interface ListedMcpServer {
  readonly name?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly transport?: unknown;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integrationSource(): string {
  return join(import.meta.dir, '..', '..', '..', '..', 'skills', 'prosto-datagram');
}

function serverName(profileName: string): string {
  return `datagram-${profileName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

function planFor(host: CliHost, profileName: string): CodexIntegrationPlan | undefined {
  const skillsDirectory = host.directories.agentSkills;
  if (skillsDirectory === undefined) return undefined;
  return {
    profileName,
    skillSource: integrationSource(),
    skillDestination: join(skillsDirectory, 'prosto-datagram'),
    mcpServerName: serverName(profileName),
    command: 'datagram-mcp',
    args: ['--profile', profileName],
    credentialReference: 'selected Service profile identity (redacted)',
  };
}

async function command(host: CliHost, name: string, args: readonly string[]): Promise<ExternalCommandResult | undefined> {
  try {
    return await host.runExternalCommand({ command: name, args });
  } catch {
    return undefined;
  }
}

function parseServers(value: string): readonly ListedMcpServer[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed as ListedMcpServer[];
    if (typeof parsed === 'object' && parsed !== null && 'mcp_servers' in parsed) {
      const servers = (parsed as { mcp_servers?: unknown }).mcp_servers;
      return Array.isArray(servers) ? (servers as ListedMcpServer[]) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function matchingServer(servers: readonly ListedMcpServer[], plan: CodexIntegrationPlan): boolean {
  const found = servers.find((candidate) => candidate.name === plan.mcpServerName);
  if (found === undefined) return false;
  const stdio =
    found.transport === undefined ||
    found.transport === 'stdio' ||
    (typeof found.transport === 'object' && found.transport !== null &&
      (!('type' in found.transport) || found.transport.type === 'stdio'));
  const commandValue =
    found.command ??
    (typeof found.transport === 'object' && found.transport !== null && 'command' in found.transport
      ? found.transport.command
      : undefined);
  const argsValue =
    found.args ??
    (typeof found.transport === 'object' && found.transport !== null && 'args' in found.transport
      ? found.transport.args
      : undefined);
  return stdio && commandValue === plan.command && JSON.stringify(argsValue ?? []) === JSON.stringify(plan.args);
}

async function listedServers(host: CliHost): Promise<readonly ListedMcpServer[] | undefined> {
  const listed = await command(host, 'codex', ['mcp', 'list', '--json']);
  if (listed?.exitCode !== 0) return undefined;
  return parseServers(listed.stdout);
}

export async function discoverCodexIntegration(
  host: CliHost,
  profileName: string,
  coreHealthy: boolean,
): Promise<CodexIntegrationDiscovery> {
  if (!coreHealthy) return { available: false, reason: 'core Service is not Doctor-ready' };
  const plan = planFor(host, profileName);
  if (plan === undefined) {
    return { available: false, reason: 'Codex user skill location is unavailable' };
  }
  if (
    host.filesystem.canWritePath === undefined ||
    !(await host.filesystem.canWritePath(plan.skillDestination))
  ) {
    return { available: false, reason: 'Codex user skill location is not writable' };
  }
  for (const file of skillFiles) {
    if (!(await host.filesystem.pathExists(join(plan.skillSource, file)))) {
      return { available: false, reason: 'packaged Datagram skill is unavailable' };
    }
  }
  const codexVersion = await command(host, 'codex', ['--version']);
  if (codexVersion?.exitCode !== 0) return { available: false, reason: 'compatible Codex CLI was not found' };
  const mcpExecutable = await command(host, 'datagram-mcp', [
    '--check',
    '--profile',
    profileName,
  ]);
  if (mcpExecutable?.exitCode !== 0) {
    return {
      available: false,
      reason: '`datagram-mcp` cannot verify the selected profile; run Doctor or install durable commands',
    };
  }
  if ((await listedServers(host)) === undefined) {
    return { available: false, reason: 'Codex MCP configuration cannot be inspected' };
  }
  return { available: true, plan };
}

async function installSkill(host: CliHost, plan: CodexIntegrationPlan): Promise<'verified' | 'conflict'> {
  const manifestPath = join(plan.skillDestination, manifestName);
  const destinationExists = await host.filesystem.pathExists(plan.skillDestination);
  const manifestExists = await host.filesystem.pathExists(manifestPath);
  const agentsDirectory = join(plan.skillDestination, 'agents');
  if (
    host.filesystem.isSymbolicLink === undefined ||
    (destinationExists && (await host.filesystem.isSymbolicLink(plan.skillDestination))) ||
    ((await host.filesystem.pathExists(agentsDirectory)) &&
      (await host.filesystem.isSymbolicLink(agentsDirectory)))
  ) {
    return 'conflict';
  }
  const sourceValues = await Promise.all(
    skillFiles.map(async (file) => [file, await host.filesystem.readTextFile(join(plan.skillSource, file))] as const),
  );
  if (destinationExists && !manifestExists) {
    const identical = await Promise.all(
      sourceValues.map(async ([file, value]) =>
        (await host.filesystem.pathExists(join(plan.skillDestination, file))) &&
        (await host.filesystem.readTextFile(join(plan.skillDestination, file))) === value),
    );
    if (!identical.every(Boolean)) return 'conflict';
  }
  if (manifestExists) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await host.filesystem.readTextFile(manifestPath));
    } catch {
      return 'conflict';
    }
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('owner' in manifest) ||
      manifest.owner !== 'prosto-datagram' ||
      !('files' in manifest) ||
      typeof manifest.files !== 'object' ||
      manifest.files === null
    ) {
      return 'conflict';
    }
    const recorded = manifest.files as Record<string, unknown>;
    const unchanged = await Promise.all(
      skillFiles.map(async (file) =>
        typeof recorded[file] === 'string' &&
        (await host.filesystem.pathExists(join(plan.skillDestination, file))) &&
        digest(await host.filesystem.readTextFile(join(plan.skillDestination, file))) === recorded[file]),
    );
    if (!unchanged.every(Boolean)) return 'conflict';
  }
  await host.filesystem.makeDirectory(agentsDirectory, { recursive: true });
  for (const [file, value] of sourceValues) {
    await host.filesystem.writeTextFileAtomic(join(plan.skillDestination, file), value, { mode: 0o644 });
  }
  const files = Object.fromEntries(sourceValues.map(([file, value]) => [file, digest(value)]));
  await host.filesystem.writeTextFileAtomic(
    manifestPath,
    `${JSON.stringify({ version: 1, owner: 'prosto-datagram', files }, null, 2)}\n`,
    { mode: 0o644 },
  );
  return 'verified';
}

async function installedSkillIsVerified(host: CliHost, plan: CodexIntegrationPlan): Promise<boolean> {
  const manifestPath = join(plan.skillDestination, manifestName);
  if (!(await host.filesystem.pathExists(manifestPath))) return false;
  try {
    const manifest = JSON.parse(await host.filesystem.readTextFile(manifestPath)) as unknown;
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('owner' in manifest) ||
      manifest.owner !== 'prosto-datagram' ||
      !('files' in manifest) ||
      typeof manifest.files !== 'object' ||
      manifest.files === null
    ) {
      return false;
    }
    const recorded = manifest.files as Record<string, unknown>;
    for (const file of skillFiles) {
      const path = join(plan.skillDestination, file);
      if (
        typeof recorded[file] !== 'string' ||
        !(await host.filesystem.pathExists(path)) ||
        digest(await host.filesystem.readTextFile(path)) !== recorded[file]
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function applyCodexIntegration(
  host: CliHost,
  plan: CodexIntegrationPlan,
  previous: CodexIntegrationProgress = { skill: 'pending', mcp: 'pending' },
): Promise<CodexIntegrationResult> {
  let progress = previous;
  if (progress.skill !== 'verified') {
    let installed: 'verified' | 'conflict';
    try {
      installed = await installSkill(host, plan);
    } catch {
      return {
        status: 'partial',
        progress,
        summary: 'Connect Codex: partial failure (skill installation failed; MCP unchanged)',
        recovery: `Resume with datagram init --profile ${JSON.stringify(plan.profileName)}.`,
      };
    }
    if (installed === 'conflict') {
      return {
        status: 'partial',
        progress,
        summary: 'Connect Codex: partial failure (existing skill is not Datagram-owned; MCP unchanged)',
        recovery: `Move the conflicting ${JSON.stringify(plan.skillDestination)} directory, then resume setup.`,
      };
    }
    progress = { ...progress, skill: 'verified' };
  } else if ((await installSkill(host, plan)) === 'conflict') {
    return {
      status: 'partial',
      progress: { ...progress, skill: 'pending' },
      summary: 'Connect Codex: partial failure (installed skill changed; MCP unchanged)',
      recovery: `Review the conflicting ${JSON.stringify(plan.skillDestination)} directory, then resume setup.`,
    };
  }

  let servers = await listedServers(host);
  if (servers === undefined) {
    return {
      status: 'partial', progress,
      summary: 'Connect Codex: partial failure (skill installed; MCP configuration unavailable)',
      recovery: `Restore Codex MCP access, then resume with datagram init --profile ${JSON.stringify(plan.profileName)}.`,
    };
  }
  const named = servers.find((candidate) => candidate.name === plan.mcpServerName);
  if (named !== undefined && !matchingServer(servers, plan)) {
    return {
      status: 'partial', progress,
      summary: 'Connect Codex: partial failure (skill installed; same-name MCP server has different configuration)',
      recovery: `Review Codex MCP server ${JSON.stringify(plan.mcpServerName)}; unrelated configuration was preserved.`,
    };
  }
  if (!matchingServer(servers, plan)) {
    const added = await command(host, 'codex', [
      'mcp', 'add', plan.mcpServerName, '--', plan.command, ...plan.args,
    ]);
    if (added?.exitCode !== 0) {
      return {
        status: 'partial', progress,
        summary: 'Connect Codex: partial failure (skill installed; MCP registration failed)',
        recovery: `Resume with datagram init --profile ${JSON.stringify(plan.profileName)}.`,
      };
    }
    servers = await listedServers(host);
  }
  if (servers === undefined || !matchingServer(servers, plan)) {
    return {
      status: 'partial', progress,
      summary: 'Connect Codex: partial failure (skill installed; MCP registration could not be verified)',
      recovery: `Inspect codex mcp list, then resume with datagram init --profile ${JSON.stringify(plan.profileName)}.`,
    };
  }
  const connection = await command(host, plan.command, ['--check', ...plan.args]);
  if (connection?.exitCode !== 0) {
    return {
      status: 'partial',
      progress,
      summary: 'Connect Codex: partial failure (skill and MCP registered; person-scoped connection failed)',
      recovery: `Run datagram doctor --profile ${JSON.stringify(plan.profileName)}, then resume setup.`,
    };
  }
  progress = { skill: 'verified', mcp: 'verified' };
  return {
    status: 'verified', progress,
    summary: `Connect Codex: verified (skill and ${plan.mcpServerName} MCP; person authority via profile ${JSON.stringify(plan.profileName)})`,
  };
}

export async function verifyCodexIntegration(
  host: CliHost,
  profileName: string,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  const plan = planFor(host, profileName);
  if (plan === undefined) return { ok: false, reason: 'Codex user skill location is unavailable' };
  if (!(await installedSkillIsVerified(host, plan))) {
    return { ok: false, reason: 'Datagram skill is missing or changed' };
  }
  const servers = await listedServers(host);
  if (servers === undefined || !matchingServer(servers, plan)) {
    return { ok: false, reason: 'Datagram MCP registration is missing or changed' };
  }
  const connection = await command(host, plan.command, ['--check', ...plan.args]);
  return connection?.exitCode === 0
    ? { ok: true }
    : { ok: false, reason: 'person-scoped Datagram MCP connection failed' };
}
