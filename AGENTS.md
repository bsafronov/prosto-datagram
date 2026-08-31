# Prosto.Datagram agent guidance

Before changing domain behavior, read `CONTEXT.md` and the relevant record in `docs/adr/`.

Keep dependencies pointing inward: adapters → application → domain. The Store is a port owned by the application boundary; Channel Types and agents never access a database directly.

All writes must follow Action → Operation → atomic Store commit. CLI, HTTP, MCP, UI, and workflows must reuse the same Action definitions, permission checks, and validation.

Preserve the zero-data agent boundary. Agent-facing queries may return control metadata and opaque Result Handles, never Store-derived or derived values—including values embedded in titles, errors, or previews. Prompt-supplied values may enter Action inputs.

Keep the scaffold narrow. Record broader product decisions in `CONTEXT.md` or an ADR; do not implement deferred behavior incidentally.

Run `bun run check` before handing off changes.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.
