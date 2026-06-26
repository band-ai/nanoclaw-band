---
name: add-band
description: Add Band.ai channel integration. The product formerly known as Thenvoi — channel type `band`, BAND_* settings, domain app.band.ai.
---

# Add Band.ai Channel

Adds Band.ai chat support to NanoClaw. The channel registers as `band`, platform
IDs use the `band:` prefix, and configuration uses `BAND_*` environment variables
(legacy `THENVOI_*` names are honored as a fallback).

Band installs **additively**, exactly like every other channel skill: copy the
Band files in from the `band` branch, append three self-registration imports,
install the pinned SDK, build. No `git merge`, no tags, no source-level edits to
core. The generic core seams Band rides — the inbound-delivery ledger,
channel-migration registry, container lifecycle hooks, and user-visible-tool
registry — already live in trunk, so nothing in core needs to change. The Band
channel migrations register themselves on import (no separate migration wiring).

## Prerequisites

> **The `band` branch must be published first.** This skill copies every Band
> file from `origin/band`. That long-lived branch (parallel to the `channels`
> branch other channels ship from) is **not yet pushed**. Until it is,
> `git fetch origin band` will fail and there is nothing to copy. Push the `band`
> branch before running this skill. Do not substitute a different branch unless
> you have confirmed it carries the same Band file set and is kept in sync with
> trunk's seam types.

> **Install onto a Band-free base.** This skill assumes core does **not** already
> contain the Band files (a clean trunk / `validate/band-free-base` checkout). If
> Band code is already inlined into your tree, you are not installing additively —
> stop and reconcile first. The Pre-flight check below tells you which case you
> are in.

## Install

### Base requirement — the channel seams must already be present

Band rides six generic core **seams** (channel-migration registry, delivery-ack
gating, graceful-stop window, MCP/user-visible-tool contribution, container
lifecycle hooks, env-precedence). They ship in the fork `main`, **not** in this
skill — so installing Band onto a base that lacks them (e.g. a plain upstream
checkout) would copy the files and then fail the build with cryptic
"undefined export" errors. Verify the base first:

```bash
missing=0
grep -q 'registerChannelMigrations' src/db/migrations/index.ts                  || { echo "missing seam: channel-migration registry"; missing=1; }
grep -q 'supportsDeliveryAck'        src/channels/adapter.ts                     || { echo "missing seam: delivery-ack capability"; missing=1; }
grep -q 'needsGracefulStop'          src/channels/adapter.ts                     || { echo "missing seam: graceful-stop capability"; missing=1; }
grep -q 'userVisibleTools'           src/providers/provider-container-registry.ts || { echo "missing seam: mcpServers/userVisibleTools contribution"; missing=1; }
test -f container/agent-runner/src/lifecycle.ts                                  || { echo "missing seam: container lifecycle hooks"; missing=1; }
test -f container/agent-runner/src/mcp-servers.ts                                || { echo "missing seam: buildMcpServers"; missing=1; }
[ "$missing" = 0 ] && echo "seams present — base is ready" || echo "STOP: base lacks the channel seams"
```

If any seam is missing you are **not** on a seam-equipped base — do **not**
proceed with the copy. Pull the fork `main` (which carries the seams), then
re-run. The seams are generic core (not Band-specific) and are a candidate to
upstream to qwibitai/nanoclaw, after which any upstream install is a valid base.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/band.ts` and `src/modules/band-config.ts` exist
- `src/db/migrations/module-band-state.ts` and `src/db/migrations/020-band-rename.ts` exist
- `src/channels/index.ts` contains `import './band.js';`
- `container/agent-runner/src/mcp-tools/band.ts` and `container/agent-runner/src/band-lifecycle.ts` exist
- `container/agent-runner/src/mcp-tools/index.ts` contains `import './band.js';`
- `container/agent-runner/src/index.ts` contains `import './band-lifecycle.js';`
- `@band-ai/sdk` and `@band-ai/rest-client` are listed in `package.json`
- `@band-ai/sdk` is listed in `container/agent-runner/package.json`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the band branch

```bash
git fetch origin band
```

If this fails, see **Prerequisites** above — the branch is not yet published.

### 2. Copy the Band files in

Copy the full tested Band file set (adapter, config, two channel migrations, the
container MCP tool + memory hooks + lifecycle registration, and all their tests):

```bash
for f in \
  src/channels/band.ts \
  src/channels/band.test.ts \
  src/modules/band-config.ts \
  src/db/migrations/module-band-state.ts \
  src/db/migrations/020-band-rename.ts \
  container/agent-runner/src/mcp-tools/band.ts \
  container/agent-runner/src/mcp-tools/band.test.ts \
  container/agent-runner/src/mcp-tools/band.instructions.md \
  container/agent-runner/src/band-lifecycle.ts \
  container/agent-runner/src/band-memory-load.ts \
  container/agent-runner/src/band-memory-load.test.ts \
  container/agent-runner/src/band-memory-consolidate.ts \
  container/agent-runner/src/band-memory-consolidate.test.ts ; do
  mkdir -p "$(dirname "$f")"
  git show "origin/band:$f" > "$f"
done
```

`src/channels/band.ts` registers the two Band channel migrations on import
(`registerChannelMigrations('band', [moduleBandState, bandRename])`), so the
copied files carry their own migration wiring — **do not** edit the core
migration barrel.

### 3. Append the three self-registration imports (skip any already present)

`src/channels/index.ts` — registers the host channel adapter:

```typescript
import './band.js';
```

`container/agent-runner/src/mcp-tools/index.ts` — registers the room-scoped
`band_*` tools:

```typescript
import './band.js';
```

`container/agent-runner/src/index.ts` — registers the start/stop lifecycle hooks
(participant-memory load + end-of-session consolidation). This import **must come
after** the `import './providers/index.js';` line (so providers register first)
and **before** the `runStartHooks(...)` call:

```typescript
import './band-lifecycle.js';
```

### 4. Install the pinned dependencies

Pinned to exact versions (never a range, per the supply-chain policy). The host
needs both the SDK and the REST client; the agent-runner container tree needs the
SDK only.

```bash
# host (Node + pnpm)
pnpm add @band-ai/sdk@0.1.6 @band-ai/rest-client@0.0.121

# container (agent-runner is a separate Bun package tree — bun, not pnpm)
cd container/agent-runner && bun add @band-ai/sdk@0.1.6 && cd -
```

> `@band-ai/sdk@0.1.6` still exports its link class under the **pre-rename** name
> `ThenvoiLink`. The host adapter imports it as `ThenvoiLink as BandLink`; the
> container modules import `ThenvoiLink` directly (plus `AgentTools` from
> `@band-ai/sdk/runtime`). This is expected — do not "fix" the import to a
> `BandLink` export that the published package does not have. [VERIFY.md](VERIFY.md)
> step 2 guards against version skew here.

### 5. Build host + container

```bash
pnpm run build
./container/build.sh
```

The base Band channel — receiving and replying in Band rooms via the room-scoped
`band_*` container tools — needs **no** python3 and **no** band-mcp. Rebuilding
the image lets the agent-runner overlay pick up the copied container files.

### 6. Verify

Run the checks in [VERIFY.md](VERIFY.md). At minimum:

```bash
pnpm test -- src/channels/band.test.ts
cd container/agent-runner && bun test src/mcp-tools/band.test.ts && cd -
```

## Credentials

Add the agent credentials to `.env`:

```bash
BAND_AGENT_ID=your-agent-id
BAND_API_KEY=your-agent-api-key
# Optional. Defaults to https://app.band.ai when unset.
BAND_BASE_URL=https://app.band.ai
# Optional. UUID of the Band user who owns this agent. Falls back to GET /agent/me.
BAND_OWNER_ID=
```

### Where these values come from

- **`BAND_API_KEY` (create scope):** your personal Band API key from app.band.ai
  → Settings → API Keys. Used **only** to mint the agent below; not stored
  long-term.
- **`BAND_AGENT_ID` + `BAND_API_KEY` (agent scope):** run the bundled helper,
  which registers a Band external agent and prints both. The printed
  `BAND_API_KEY` is the **agent-scoped** key and replaces the create-scope one:

  ```bash
  export BAND_API_KEY=<your create-scope key>     # or omit to paste at the prompt
  eval "$(.claude/skills/add-band/scripts/register-agent.sh)"
  # → prints BAND_AGENT_ID=<uuid> and BAND_API_KEY=<agent-scoped key>
  ```

  Append the two printed lines to `.env` (the agent-scoped `BAND_API_KEY`
  overwrites the create-scope value). These are the exact names the adapter reads
  (`src/modules/band-config.ts`). The script never echoes the create-scope key
  and never passes it on `argv`.
- **`BAND_OWNER_ID` (optional):** the Band user UUID that owns this agent —
  app.band.ai → your profile. Leave unset to let the adapter fall back to
  `GET /agent/me`.
- **Room IDs:** you do **not** set these. Discovery writes Band rooms into
  `messaging_groups` automatically; you wire them with `/manage-channels`
  (platform id `band:<room-id>`). The container vars `BAND_ROOM_ID` /
  `BAND_REST_URL` are injected per-session by the adapter — never put them in
  `.env`.

For hosted Band.ai, leave `BAND_BASE_URL` unset (or `https://app.band.ai`) and let
OneCLI inject `BAND_API_KEY` at request time — direct env injection into
containers is only for local HTTP validation or explicit `BAND_INJECT_API_KEY=true`.
Installs with legacy `THENVOI_*` variables keep working; `BAND_*` takes precedence.

Memory pre-load/consolidation and contact-event handling are off by default. To
enable them, see [reference/configuration.md](reference/configuration.md).

If this instance reads its environment from `data/env/env`, sync it:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Wire Band rooms

Discovery writes rooms into `messaging_groups` but does **not** wire them to an
agent. Run `/manage-channels` and wire the room:

- **type**: `band`
- **platform ID format**: `band:<room-id>`
- **session mode**: `shared` for room-local conversations; `agent-shared` only when
  intentionally merging multiple surfaces into one agent session

## Outbound origination: Band MCP (optional, advanced)

The native `band_*` tools above are room-scoped — they act inside a Band room the
agent already serves, and they cover the entire base channel (receive + reply). No
band-mcp is needed for that, and the base install above adds nothing to the
Dockerfile.

Letting your **global / DM** assistant *originate* Band activity from outside Band
("make a Band chat with X and post Y there") is a separate, optional capability:
the standalone `band-mcp` server, wired into **one** global / non-room agent
group's container config (never into a Band-room agent group). It requires manual
Dockerfile edits to install the Python package and an OneCLI `X-API-Key` secret.
See [reference/configuration.md](reference/configuration.md#outbound-origination-band-mcp-global-agent-only).

## Channel Info

- **type**: `band`
- **user-facing name**: Band.ai
- **terminology**: rooms/chats; the main control room is the owner-visible direct
  room and blocks room/participant mutation tools
- **platform-id-format**: `band:<roomId>`
- **supports-threads**: no
- **default-isolation**: same agent group for your own Band rooms; separate agent
  groups for rooms with different people, projects, or data boundaries

## Features

- Native Band ingestion through the Band SDK
- Claude-visible platform tools exposed as `band_*`
- Fallback outbound delivery for ordinary `messages_out` chat rows
- Main-room detection, container env propagation, and mutation guardrails
- Optional participant-memory pre-load and end-of-session consolidation
  (`BAND_MEMORY_*`) — see [reference/configuration.md](reference/configuration.md)
- Contact-event handling: drop or hub-room forwarding (`BAND_CONTACT_STRATEGY`)

## Troubleshooting

Messages appear in Band but the agent stays silent → the room is discovered but
not wired:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, channel_type, platform_id, name FROM messaging_groups WHERE channel_type='band'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT messaging_group_id, agent_group_id, session_mode FROM messaging_group_agents"
```

Tools missing inside the container → confirm the session is Band-backed and that
`container/agent-runner/src/mcp-tools/index.ts` imports `./band.js`.

Memory tools return disabled/unavailable → leave them disabled for that run; do
not claim memory was stored unless a `band_store_memory` call succeeded.

To uninstall, see [REMOVE.md](REMOVE.md). To smoke-test, see [VERIFY.md](VERIFY.md).
