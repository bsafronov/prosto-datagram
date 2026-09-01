---
name: prosto-datagram
description: Operate Prosto Datagram through its shared Action and Query contracts. Use when a user asks to create or manage Datagram Channels, people, permissions, tables, records, discussions, dictionaries, charts, or other Channel-backed data through natural language.
---

# Prosto Datagram

Use Datagram MCP tools when available. In a local checkout without MCP, use the CLI equivalents:

- Discover mutations with `datagram actions`.
- Discover reads with `datagram queries`.
- Mutate with `datagram action NAME --input JSON`.
- Prepare a read with `datagram agent-query NAME --input JSON`.

Follow this protocol:

1. Use Channel and entity references supplied by the user, host, or a previous Action receipt. Never guess identifiers.
2. Map the request to the smallest available Action. Values explicitly supplied in the current prompt may be included in its input.
3. Obtain approval before bulk, destructive, costly, or access-expanding Actions when the user has not already authorized them.
4. Treat a successful Action receipt—its `operationId` and optional `subject`—as mutation verification. Do not read stored data merely to verify it.
5. For reads, call a Query tool or `agent-query`. Return the opaque Result Handle to the host. Never call the human `query` CLI command, consume a Result Handle, or ask tooling to place stored or derived values in model context.
6. Treat Result Handles as actor-bound, purpose-bound, short-lived capabilities. They may be passed only to compatible rendering, aggregation, export, or workflow tooling.
7. Report Datagram error codes concisely. Change an input and retry only when the correction follows unambiguously from the user's request.

Completion reporting:

- Say an Action completed only after receiving its Action receipt. Include the `operationId` and safe subject identity when useful.
- Say a Query was prepared or a Data View was opened only after receiving its Result Handle. Do not say what the result contains.
- If a multi-Action request stops, list completed Operation IDs and the failed or unattempted step. Never claim the whole request completed.
- Runtime, transport, approval, or plan-limit failure never authorizes a CLI, HTTP, Store, or direct database fallback. Retry the same tool contract only when safe and requested.
- Codex login, session tokens, and ChatGPT subscription limits belong to Codex. Never request, copy, persist, or reinterpret them as API credentials.

Keep control metadata such as Action names, Operation IDs, entity IDs, and Channel references separate from stored data. The model orchestrates tools; the Store and trusted host own data access and rendering.
