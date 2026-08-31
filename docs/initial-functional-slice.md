# Initial Functional Slice

## Outcome

A person can use CLI or Codex to create and share typed operational data, observe collaborator Activity, and derive a live Chart without a bespoke UI or allowing the AI Agent to read stored values.

## Included

- Headless Datagram Service
- Store contract and conformance suite
- SQLite Local Store
- PostgreSQL Server Store before multi-user completion
- CLI using the public application contract
- MCP Gateway exposing the same Channel Actions and Channel Queries
- Codex skill teaching the agent to orchestrate Datagram tools
- Semantic JSON View Definition validation and generic output
- Channel core and universal Discussion
- Bundled Table, Dictionary, and Chart Channel Types
- Service-local identities, Channel Invitations, and Channel Roles
- Operations, permission checks, Activity, unread positions, and realtime subscriptions
- Result Handles and Data Views preserving the zero-data boundary

## Acceptance journey

1. Start a Local Service with SQLite and its automatic owner.
2. Ask Codex to create a `Projects` Table Channel; Codex calls the same typed Action available to CLI.
3. Add typed Fields and Records, including a Dictionary-backed Field.
4. Start a Server Service, invite another person to the Channel, and assign Contributor.
5. The Contributor adds a Record; one Operation and meaningful Channel Activity are recorded.
6. Another subscribed client receives the Activity and the Channel becomes recent and unread.
7. Ask Codex to aggregate Table data and create a Chart Channel. Tools exchange Result Handles; no stored or derived values enter model context.
8. A host renders the Chart's semantic View Definition and current values directly from the final Result Handle.
9. CLI, MCP, and agent origins produce equivalent validation, permissions, Operations, and audit evidence.

## Explicitly deferred

- Bespoke graphical UI
- Conversation Channel specialization for direct and group messaging
- Workflow execution
- Public or anonymous access
- Store synchronization and cross-Service live references
- Email, mobile push, and external notification delivery
- Third-party Channel Type installation
- End-to-end encryption against the infrastructure operator
