# Integrations use vault-backed capabilities

Integration credentials are stored by a Service-managed Secret Vault. AI Agents, Workflows, and Channel Types receive only named capabilities whose implementation uses the secret without revealing it. Capability invocation enforces actor and Channel permissions, declared scope, limits, and audit. No prompt, Result Handle, installed type, or Workflow definition contains the credential value.
