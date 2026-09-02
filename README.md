# Prosto.Datagram

Headless foundation for collaborative Channels: messages and structured data share permissions, activity, operations, and one flat navigation model.

This repository contains the first executable scaffold. It implements Channel core, universal Discussion, typed Tables, Dictionaries, live Charts, SQLite Local Store, PostgreSQL Server Store, HTTP/CLI/MCP adapters, realtime Activity, opaque agent Result Handles, and a Codex skill. Workflows remain a subsequent slice.

## Getting started

Requires Bun 1.3.13 or newer.

Start guided setup. No source checkout or manual configuration file is required:

```sh
bunx prosto-datagram init
```

Choose **Use on this machine** for a Local Service backed by SQLite in your operating-system user
data directory. Choose **Run for a team** for a Server Service backed by either an externally owned
PostgreSQL database or persistent Docker-managed PostgreSQL. Setup shows a redacted plan and writes
nothing before Apply. Safe defaults use local-only exposure; public exposure requires explicit TLS
or an existing HTTPS reverse proxy.

Setup creates a named **Service profile** containing non-secret host configuration and credential
references. One profile is the default. Target another configured Service explicitly:

```sh
bunx prosto-datagram actions --profile team
bunx prosto-datagram doctor --profile team
```

`doctor` verifies profile access, credentials, Store/runtime readiness, authenticated identity,
managed infrastructure, and configured optional integrations. It reports the failing stage plus an
exact repair command without showing credentials or Channel data. Rerun setup to inspect, repair,
or resume an interrupted profile:

```sh
bunx prosto-datagram init --profile team
```

Repair and reruns preserve profiles, secrets, databases, managed volumes, Channels, and Records.
They never perform destructive cleanup.

### Managed PostgreSQL

The Docker option creates one persistent PostgreSQL container and volume owned by the selected
Service profile. Docker is never installed automatically. Operate that infrastructure explicitly:

```sh
bunx prosto-datagram postgres status --profile team
bunx prosto-datagram postgres stop --profile team
bunx prosto-datagram postgres start --profile team
```

Stopping PostgreSQL does not remove its container or volume. Back up the volume named in the setup
receipt. These lifecycle commands are unavailable for external PostgreSQL because Datagram does not
own that infrastructure.

### Optional integrations and durable commands

After core Service verification, compatible setups can optionally **Connect Codex**. This installs
the packaged Datagram Codex skill, registers the profile-scoped MCP Gateway, and verifies the
connection using the person's Service identity. Skipping or failing this optional stage leaves the
Service usable; rerun `init --profile NAME` to resume it. Setup does not install generic agents or
third-party Channel Types.

Setup can also preview and, after explicit consent, run `bun install --global prosto-datagram` for
durable `datagram` and `datagram-mcp` commands. Declining keeps the exact `bunx` commands shown in
the receipt. A failed optional installation does not invalidate the configured Service.

### Know the boundaries

- A **Deployment Operator** configures and diagnoses one Datagram Service. Operator authority does
  not grant access to Channel contents.
- A **Channel Owner** owns one Channel and controls its membership. This is a Channel role, not a
  Service infrastructure role.
- A **Service profile** is local, non-secret operational configuration selecting one Service. It is
  not Datagram domain data or a Store.
- A **Channel Type** defines Channel behavior, Actions, Queries, records, and semantic views. The
  guided starter uses the built-in Table Channel Type.
- A **Codex skill** teaches Codex how to operate Datagram. It is host configuration, not a Channel
  Type and not Service data.
- The **MCP Gateway** exposes permission-checked Datagram Actions and zero-data agent Queries. It is
  not a database interface and never gives Store-derived values to the model.

Initial guided setup supports macOS and Linux. Windows setup, public answer files, generic
multi-agent installation, standalone binaries, and automatic destructive cleanup are outside this
release.

## Contributor setup

```sh
bun install
bun run check
bun run cli init
```

`bun run check` always proves PostgreSQL conformance and the same acceptance journey against a
real Server Store. It uses `DATAGRAM_TEST_POSTGRES_URL` when set; otherwise it provisions an
ephemeral `postgres:17-alpine` Docker container pinned by an immutable multi-platform digest and
removes it after testing. Docker or an explicit test URL is required; PostgreSQL verification never
skips.

Run only the PostgreSQL gate against an existing database:

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
