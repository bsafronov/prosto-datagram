# Prosto.Datagram

Headless foundation for collaborative Channels: messages and structured data share permissions, activity, operations, and one flat navigation model.

This repository contains the first executable scaffold. It implements Channel core, universal Discussion, typed Tables, Dictionaries, live Charts, SQLite Local Store, PostgreSQL Server Store, HTTP/CLI/MCP adapters, realtime Activity, opaque agent Result Handles, and a Codex skill. Workflows remain a subsequent slice.

## Run it

Requires Bun 1.3.13 or newer.

```sh
bun install
bun run check
bun run cli init
```

Run PostgreSQL conformance and the same acceptance journey against a real Server Store:

```sh
DATAGRAM_TEST_POSTGRES_URL='postgres://datagram:secret@127.0.0.1/datagram' \
bun run test:postgres
```

Local commands use `datagram.sqlite` by default. Override it with `DATAGRAM_DB` or `--db PATH`.

Create a Table Channel:

```sh
bun run cli action channel.create \
  --input '{"title":"Products","typeId":"table"}'
```

Inspect the available public contracts:

```sh
bun run cli actions
bun run cli queries
```

Start the MCP Gateway over stdio:

```sh
bun run mcp
```

Set `DATAGRAM_ACTOR_ID` to a verified Service identity before starting MCP. MCP does not fall back to the automatic Local Owner. CLI may use its explicit local-development default.

Run an authoritative PostgreSQL Server Service with bearer-token authentication:

```sh
DATAGRAM_POSTGRES_URL='postgres://datagram:secret@127.0.0.1/datagram' \
DATAGRAM_OPERATOR_TOKEN='replace-with-a-secret' \
bun run serve
```

Server bootstrap creates one Deployment Operator identity, but no Channel or Channel membership. `DATAGRAM_AUTH_TOKENS` may contain a JSON object mapping additional bearer tokens to existing Service person IDs. `DATAGRAM_OPERATOR_TOKEN` maps only to the bootstrapped Deployment Operator. Operator authority never grants Channel access.

`datagram serve --db PATH` remains a trusted local-development HTTP process using SQLite. Do not expose that local adapter to untrusted clients.

## Contracts

Every mutation goes through one named Action and commits one atomic Operation. The same Action Registry powers CLI, HTTP, and MCP.

HTTP exposes:

- `GET /health`
- `GET /v1/actions` and `GET /v1/queries`
- `POST /v1/actions/:name`
- `POST /v1/queries/:name` for trusted human-facing hosts
- `POST /v1/agent/queries/:name` for zero-data Result Handles

Server clients send `Authorization: Bearer TOKEN`. Missing, unknown, and deactivated identities receive `401`.

MCP mutation tools return only Action receipts. MCP Query tools return actor- and purpose-bound Result Handles plus sanitized semantic view metadata; Store-derived values never enter model context.

## Structure

```text
src/packages/domain        Channel vocabulary, types, errors, Channel Type Registry
src/packages/application   shared Action/Query contracts, Store port, permissions, Result Handles
src/packages/sqlite-store  SQLite Store adapter
src/packages/postgres-store PostgreSQL Store adapter
src/packages/http          HTTP adapter
src/packages/cli           human and operational CLI
src/packages/mcp           zero-data agent gateway
src/cli.ts                 CLI executable shim
src/mcp.ts                 MCP executable shim
skills/          Codex operation skill
docs/adr/        accepted product and architecture decisions
```

Read [CONTEXT.md](./CONTEXT.md) for the canonical domain language and [the initial functional slice](./docs/initial-functional-slice.md) for the target acceptance journey.
