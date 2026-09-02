export { cliUsage, runCli, writeCliFailure } from './lib/cli';
export {
  createProcessCliHost,
  resolvePlatformDirectories,
  type CliFileSystem,
  type CliHost,
  type CliHttpServer,
  type CliPlatformDirectories,
  type CliTerminal,
  type ExternalCommandRequest,
  type ExternalCommandResult,
} from './lib/host';
export type {
  CredentialProvider,
  CredentialProviderAvailability,
  CredentialReference,
  NativeCredentialReference,
  NativeCredentialProviderKind,
} from './credentials';
export {
  applyCodexIntegration,
  discoverCodexIntegration,
  verifyCodexIntegration,
  type CodexIntegrationDiscovery,
  type CodexIntegrationPlan,
  type CodexIntegrationProgress,
  type CodexIntegrationResult,
} from './lib/integrations';
export {
  isServerProfile,
  readServiceProfile,
  resolveCredential,
  resolveServiceTarget,
  type LocalServiceProfile,
  type ResolvedServiceTarget,
  type ServerServiceProfile,
  type ServiceProfile,
  type TargetOptions,
} from './lib/profiles';
