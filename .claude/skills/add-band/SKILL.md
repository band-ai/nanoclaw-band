---
name: add-band
description: Add Band.ai channel integration. The product formerly known as Thenvoi — channel type `band`, BAND_* settings, domain app.band.ai.
---

# Add Band.ai Channel

Adds Band.ai chat support to NanoClaw. The channel registers as `band`, platform
IDs use the `band:` prefix, and configuration uses `BAND_*` environment variables
(legacy `THENVOI_*` names are honored as a fallback).

Band installs **additively**, exactly like every other channel skill: copy the
Band files in from the `band/adapter` branch, append three self-registration imports,
install the pinned SDK, build. No `git merge`, no tags, no source-level edits to
core. The generic core seams Band rides — the inbound-delivery ledger,
channel-migration registry, container lifecycle hooks, and user-visible-tool
registry — already live in trunk, so nothing in core needs to change. The Band
channel migrations register themselves on import (no separate migration wiring).

## Prerequisites

> **The Band payload lives on `band/adapter` in the fork.** This skill copies every
> Band file from `band-ai/band/adapter` — a long-lived source branch (parallel to
> the `channels` branch other channels ship from), published on
> `band-ai/nanoclaw-band` and kept 0-behind `main` by CI. The on-ramp bootstrap
> adds the `band-ai` remote and fetches it; step 1 below does the same idempotently
> for a standalone run. Do not substitute a different branch unless you have
> confirmed it carries the same Band file set and is kept in sync with trunk's seam
> types.

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

Skip to **Bring Band online (end-to-end)** if all of these are already in place:

- `src/channels/band.ts` and `src/modules/band-config.ts` exist
- `src/db/migrations/module-band-state.ts` and `src/db/migrations/020-band-rename.ts` exist
- `src/channels/index.ts` contains `import './band.js';`
- `container/agent-runner/src/mcp-tools/band.ts` and `container/agent-runner/src/band-lifecycle.ts` exist
- `container/agent-runner/src/mcp-tools/index.ts` contains `import './band.js';`
- `container/agent-runner/src/index.ts` contains `import './band-lifecycle.js';`
- `@band-ai/sdk` and `@band-ai/rest-client` are listed in `package.json`
- `@band-ai/sdk` is listed in `container/agent-runner/package.json`

Otherwise continue. Every step below is safe to re-run.

### 1. Ensure the `band-ai` remote and fetch the band/adapter branch

The Band payload lives on the fork (`band-ai/nanoclaw-band`), never on a user's
`origin` or on upstream nanoclaw. The on-ramp bootstrap adds a remote named
`band-ai` pointing at the fork; ensure it exists (idempotent) so a standalone run
behaves identically, then fetch the payload branch from it:

```bash
# The Band fork remote. `git remote add` is skipped if `band-ai` already exists.
FORK_URL="${NANOCLAW_REPO:-https://github.com/band-ai/nanoclaw-band}"
git remote get-url band-ai >/dev/null 2>&1 || git remote add band-ai "$FORK_URL"
# Explicit refspec so the remote-tracking ref refs/remotes/band-ai/band/adapter is
# created. A bare `git fetch band-ai band/adapter` only writes FETCH_HEAD on
# single-branch or shallow clones (the common bootstrap case), leaving the
# `band-ai/band/adapter` ref the copy step reads unresolved.
git fetch band-ai "+refs/heads/band/adapter:refs/remotes/band-ai/band/adapter"
```

If the fetch fails, the `band-ai` remote URL is wrong or unreachable — re-check it
against **Prerequisites** above. The copy step below resolves
`git show "band-ai/band/adapter:<file>"`, exactly the ref the explicit refspec
above creates.

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
  git show "band-ai/band/adapter:$f" > "$f"
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

## Bring Band online (end-to-end)

After the build + verify pass, drive the operator from credentials to a live,
wired Band agent. **Do every step you can yourself** — register the agent, restart
the host, query the DB, run the wiring — and hand the operator only what needs
them (pasting a create-scope key, opening a Band room, sending the test message).
Don't stop after the build; carry the flow through to a message round-trip.

### Step 1 — Credentials

The adapter reads an **agent-scoped** key from `.env`. **`register-agent.sh` is
not idempotent — each run POSTs a brand-new Band agent (new id + key).** So gate
on an existing key: a key already in `.env` means the agent was minted on a prior
run, and the whole step (register + vault + `.env` write) must be **skipped**.

```bash
grep -qE '^(BAND|THENVOI)_(AGENT_)?API_KEY=' .env 2>/dev/null && echo "key present → skip to Step 2" || echo "no key → register below"
```

**Key present → skip to Step 2** — do **not** re-run the script; it would mint a
duplicate agent. (If `.env` has a key but no `BAND_AGENT_ID` — a hand-edit — add
the matching id rather than re-registering; the host needs both. If the key is
**dead** — you deleted the agent on Band — or you want to **rotate** it, see
[Re-register or rotate the key](#re-register-or-rotate-the-key) at the end of this
step.) Otherwise register a Band external agent. That call needs a **create-scope** Band API key
(app.band.ai → Settings → API Keys), used only to mint the agent. Ask the operator
to paste it at the prompt — never put it on `argv`, never `eval` the output:

```bash
# umask 077 so the temp file holding the live key isn't world-readable.
( umask 077; .claude/skills/add-band/scripts/register-agent.sh > /tmp/band-agent.env )
# writes:  BAND_AGENT_ID=<uuid>   and   BAND_AGENT_API_KEY=<agent-scoped key>
```

The script never echoes the create-scope key and never passes it on `argv`; treat
its output as dotenv content. Route the agent key to **both** places it's needed —
the host reads it from `.env`, the container gets it from the OneCLI vault:

1. **`.env` (host).** Upsert both lines into `.env` (don't duplicate existing
   keys). The host adapter reads `BAND_AGENT_API_KEY` directly and opens the Band
   WebSocket + REST client with it (`src/modules/band-config.ts` →
   `src/channels/band.ts`); without it `getBandConfig()` returns null and the
   channel never starts — so the key must sit in `.env` locally. `BAND_AGENT_API_KEY`
   is canonical; legacy `BAND_API_KEY` and the `THENVOI_*` family still work, with
   `BAND_*` taking precedence.

2. **OneCLI vault (container).** For hosted `app.band.ai` the container never
   receives the raw key — OneCLI injects the `X-API-Key` header on egress. Store
   the same agent key in the vault, reading it back from `.env` (never paste it):

   ```bash
   KEY=$(grep -E '^(BAND|THENVOI)_(AGENT_)?API_KEY=' .env | head -1 | cut -d= -f2-)
   onecli secrets create --name Band --type generic --value "$KEY" \
     --host-pattern app.band.ai --header-name X-API-Key --value-format '{value}'
   ```

   The agent's OneCLI `secretMode` must be `all` (or assign this secret to it).
   Direct env injection of the key into a container happens only for local HTTP
   validation or explicit `BAND_INJECT_API_KEY=true`.

Once the key is in `.env` (and the vault, for hosted Band), wipe the temp file —
it holds the live agent key. This runs regardless of which routing path you took:

```bash
rm -f /tmp/band-agent.env
```

Optional vars, all defaulted:

```bash
# BAND_BASE_URL   defaults to https://app.band.ai (leave unset for hosted Band)
# BAND_OWNER_ID   Band user UUID that owns the agent; falls back to GET /agent/me
```

Memory pre-load/consolidation and contact-event handling are off by default
([reference/configuration.md](reference/configuration.md)).

If this instance mirrors env to `data/env/env`, sync it:

```bash
[ -f data/env/env ] && cp .env data/env/env
```

#### Re-register or rotate the key

The skip-on-existing-key gate assumes the key in `.env` is live. Two cases need an
explicit reset:

- **Rotate the key, same agent** — you regenerated the agent's key on Band but the
  agent still exists. Put the new key in `.env` (`BAND_AGENT_API_KEY`), then point
  the vault secret at it — no new agent is minted:

  ```bash
  onecli secrets list                 # find the "Band" secret's id
  onecli secrets update --id <secret-id> --value "$NEW_KEY" \
    --host-pattern app.band.ai --header-name X-API-Key --value-format '{value}'
  ```

- **Dead agent → mint a fresh one** — you deleted the agent on Band (the `.env`
  key is now invalid) or just want a new one. The stale key would make the gate
  skip forever, so clear it from all three places, then re-run **Step 1**:

  ```bash
  # 1. drop the stale agent creds from .env (and the data/env/env mirror)
  sed -i.bak -E '/^(BAND|THENVOI)_(AGENT_ID|AGENT_API_KEY|API_KEY)=/d' .env && rm -f .env.bak
  [ -f data/env/env ] && cp .env data/env/env
  # 2. delete the OneCLI vault secret (id from `onecli secrets list`)
  onecli secrets delete --id <secret-id>
  # 3. re-run Step 1 — the gate now sees no key and mints a fresh agent
  ```

### Step 2 — Start the host so it discovers rooms

You never enter room IDs by hand: on host start the adapter connects and writes
every room the agent can see into `messaging_groups`. Start (or restart) the host
so it picks up the new creds and the rebuilt image:

```bash
# macOS:  launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:  systemctl --user restart nanoclaw
# Dev:    pnpm run dev
```

If no service is installed yet, run `/setup` first, then return here.

### Step 3 — Confirm discovery

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, platform_id, name FROM messaging_groups WHERE channel_type='band'"
```

- **Rows present** → go to Step 4.
- **No rows** → the agent is in no rooms yet. With an owner set, the adapter
  auto-provisions a **Nano Hub** direct room on first connect; otherwise ask the
  operator to add the agent to a Band room (or DM it) at app.band.ai, then re-run
  the query. Discovery is event-driven — allow a few seconds after the room
  appears.

### Step 4 — Wire a room with `/manage-channels`

Discovery does **not** wire a room to an agent. **Invoke `/manage-channels`** to do
it: it routes you to `/init-first-agent` when no owner / agent group exists yet,
and otherwise asks the isolation question and writes the wiring row. The
Band-specific answers it needs (also in **Channel Info** below):

- **channel / type**: `band`
- **platform ID**: `band:<room-id>` (a row from Step 3)
- **session mode**: `shared` for room-local conversations; `agent-shared` only
  when intentionally merging multiple surfaces into one session
- **default isolation**: same agent group for your own rooms; a separate agent
  group for rooms with different people, projects, or data boundaries

When the target agent group already exists, you can wire non-interactively instead
of running the `/manage-channels` prompts:

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "band:<room-id>" --name "<room name>" \
  --folder "<agent-folder>" --channel "band" \
  --session-mode "shared" --assistant-name "<assistant name>"
```

### Step 5 — Verify end-to-end

With the room wired and the host running, send a message in that Band room (mention
the agent if it's mention-gated). It should reply within a few seconds. If it
stays silent, trace the round trip per [VERIFY.md](VERIFY.md) step 8 and the
**Troubleshooting** section below.

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
