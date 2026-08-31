# Prosto.Datagram

Headless foundation for collaborative Channels: messages and structured data share permissions, activity, operations, and one flat navigation model.

This repository currently contains the first executable scaffold. It implements the Channel core, universal Discussion, typed Table creation, a SQLite Store, HTTP/CLI/MCP adapters, opaque agent Result Handles, and a Codex skill. Dictionary and Chart Channel Types are registered, but their type-specific actions, aggregation, realtime delivery, PostgreSQL, and workflows remain subsequent slices.

## Run it

Requires Bun 1.3.13 or newer.

```sh
bun install
bun run check
bun run cli init
bun run serve
```

The default database is `datagram.sqlite`. Override it with `DATAGRAM_DB` or `--db PATH`.

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

Set `DATAGRAM_ACTOR_ID` when the CLI or MCP process should act as someone other than the automatic Local Owner.

The HTTP scaffold binds to `127.0.0.1` by default. `X-Datagram-Actor` is development identity selection, not authentication; do not expose this server to untrusted clients yet.

## Contracts

Every mutation goes through one named Action and commits one atomic Operation. The same Action Registry powers CLI, HTTP, and MCP.

HTTP exposes:

- `GET /health`
- `GET /v1/actions` and `GET /v1/queries`
- `POST /v1/actions/:name`
- `POST /v1/queries/:name` for trusted human-facing hosts
- `POST /v1/agent/queries/:name` for zero-data Result Handles

Use `X-Datagram-Actor` to select the acting Service identity over HTTP.

MCP mutation tools return only Action receipts. MCP Query tools return actor- and purpose-bound Result Handles plus sanitized semantic view metadata; Store-derived values never enter model context.

## Structure

```text
src/domain       Channel vocabulary, types, errors, Channel Type Registry
src/application  shared Action/Query contracts, permissions, Result Handles
src/store        Store port and SQLite adapter
src/http.ts      HTTP adapter
src/cli.ts       human and operational CLI
src/mcp.ts       zero-data agent gateway
skills/          Codex operation skill
docs/adr/        accepted product and architecture decisions
```

Read [CONTEXT.md](./CONTEXT.md) for the canonical domain language and [the initial functional slice](./docs/initial-functional-slice.md) for the target acceptance journey.
