---
name: add-band
description: Add Band.ai channel integration. The product formerly known as Thenvoi — channel type `band`, BAND_* settings, domain app.band.ai.
---

# Add Band.ai Channel

Adds Band.ai chat support to NanoClaw. The channel registers as `band`, platform
IDs use the `band:` prefix, and configuration uses `BAND_*` environment variables
(legacy `THENVOI_*` names are honored as a fallback).

Band installs **additively**, exactly like every other channel skill: copy the
Band files in from the `band/adapter` branch, append three self-registration
imports, install the pinned SDK, build. No `git merge`, no tags, no source-level
edits to core. The generic core seams Band rides — the inbound-delivery ledger,
channel-migration registry, container lifecycle hooks, and user-visible-tool
registry — already live in trunk, so nothing in core changes. The Band channel
migrations register themselves on import.

## Before you start (decide once, then run autonomously)

This skill is **pointed**: it auto-detects state and only stops for the few
actions a human must perform. Settle these up front so the flow doesn't stall
mid-way — the previous failure mode was discovering a decision or a blocked
permission three steps in.

1. **Scope — ask the operator one question, once:** *code install only*, or
   *full live bring-up* (install → credentials → discovery → wiring → a real
   message round-trip)? Default to **full bring-up**. Do not re-ask "how far
   should I take this?" later — Phase 0 detects what's already done and resumes
   from there.

2. **Two approval gates are expected — name the source up front.** Copying Band's
   files and installing the `@band-ai/*` packages pull code from an **external
   fork**, so Claude Code's auto-mode security classifier will gate both steps as
   untrusted-code integration. That is by design, not an error. Before step 1,
   tell the operator plainly:

   > Installing Band copies 14 files from `https://github.com/band-ai/nanoclaw-band`
   > (branch `band/adapter`) and installs `@band-ai/sdk@0.1.6` +
   > `@band-ai/rest-client@0.0.121`. Both will ask for your approval.

   Then agree how to clear them: either the operator pre-grants (re-run in a mode
   that permits it, or add Bash rules for `git show:*` / `pnpm add` / `bun add`),
   or they run the two commands themselves with the `!` prefix and you continue.
   **Never route around the classifier** — surface it and let the operator decide.

3. **Human touchpoints (everything else is automatic):** possibly pasting a
   create-scope Band key *only if no credentials exist yet*; opening or DMing a
   Band room so it's discoverable; **choosing the access level** to grant the
   owner's Band identity (owner / admin / member — Step 6); and sending the final
   test message. Phase 0 below tells you which of these actually apply.

4. **A stale-marker tripwire trip on restart is expected on old installs — it's
   not this skill breaking something.** Phase 1 Step 5's `pnpm run build`
   recompiles `dist/`; if this checkout's `dist/` predates NanoClaw's upgrade
   tripwire (`src/upgrade-state.ts`), the rebuild is the first time that check
   ever actually runs, and a marker recorded before the tripwire existed won't
   match. Phase 0 checks for this up front so it's not a surprise; Step 3's
   restart uses `scripts/safe-restart.sh`, which detects the trip and heals it
   automatically (see docs/upgrade-recovery.md). If it still fails after that
   one auto-heal, stop and investigate — that's a real problem, not this case.

## Phase 0 — Anchor to the repo root and detect state (no questions)

**Anchor first.** Every step assumes the **repo root** as the working directory.
The single biggest install failure has been running the copy loop from
`.claude/skills`, depositing files into `.claude/skills/src/...`. Pin the root and
keep it in every command:

```bash
cd "$(git rev-parse --show-toplevel)" || { echo "not in a git checkout"; exit 1; }
ROOT="$PWD"; export PROJECT_ROOT="$ROOT"
source "$ROOT/setup/lib/install-slug.sh"   # launchd_label / systemd_unit / container_image_base
```

Then detect everything the rest of the skill branches on, in one pass:

```bash
echo "=== base seams (must all pass) ==="
missing=0
grep -q 'registerChannelMigrations' src/db/migrations/index.ts                   || { echo "MISSING: channel-migration registry"; missing=1; }
grep -q 'supportsDeliveryAck'        src/channels/adapter.ts                      || { echo "MISSING: delivery-ack capability"; missing=1; }
grep -q 'needsGracefulStop'          src/channels/adapter.ts                      || { echo "MISSING: graceful-stop capability"; missing=1; }
grep -q 'userVisibleTools'           src/providers/provider-container-registry.ts || { echo "MISSING: userVisibleTools contribution"; missing=1; }
test -f container/agent-runner/src/lifecycle.ts                                   || { echo "MISSING: container lifecycle hooks"; missing=1; }
test -f container/agent-runner/src/mcp-servers.ts                                 || { echo "MISSING: buildMcpServers"; missing=1; }
[ "$missing" = 0 ] && echo "seams: present — base is ready" || echo "seams: STOP — base lacks the channel seams"

echo "=== Band already installed? ==="
{ test -f src/channels/band.ts && grep -q "import './band.js';" src/channels/index.ts; } \
  && echo "band code: INSTALLED (Phase 1 is a no-op; verify, then bring online)" \
  || echo "band code: not installed (run Phase 1)"

echo "=== credentials ==="
grep -qE '^(BAND|THENVOI)_(AGENT_)?API_KEY=' .env 2>/dev/null \
  && echo "creds: present (skip registration in bring-up Step 1)" || echo "creds: missing (register in bring-up Step 1)"

echo "=== this checkout's service + image ==="
echo "service label: $(launchd_label)   |   image: $(container_image_base):latest"
echo "webhook port:  $(grep -E '^WEBHOOK_PORT=' .env 2>/dev/null | cut -d= -f2 || echo '3000 (default)')"

echo "=== upgrade tripwire ==="
if pnpm exec tsx scripts/upgrade-state.ts check; then
  echo "marker: current — Step 3's restart will not trip"
else
  echo "marker: drifted — expected on an old install meeting the tripwire for the"
  echo "  first time (see 'Before you start' point 4); Step 3's safe-restart.sh heals it"
fi
```

If the seam check says STOP, you are not on a seam-equipped base — pull the fork
`main` (which carries the seams) and re-run. Do **not** copy Band onto a base that
lacks them; the build would fail with cryptic "undefined export" errors.

If `band code: INSTALLED`, Phase 1 is already done (idempotent re-run) — go
straight to **Verify** then **Bring Band online**.

## Phase 1 — Install the code

### 1. Fetch the fork — payload from `band/adapter`, skill from `main`

The fork (`band-ai/nanoclaw-band`) carries **two refs you must keep straight** —
they are not interchangeable:

- **`band/adapter`** — the Band *payload* (adapter, config, migrations, container
  tools, tests). A long-lived source branch parallel to the `channels` branch,
  kept 0-behind `main` by CI. Step 2 copies from here; upstream `main` is Band-free
  and does not carry these files.
- **`main`** — the canonical home of *this skill*. Refresh the skill and resolve any
  skill-path conflict from here (see **Upgrading / staying in sync**).

Resolve whichever remote points at the fork — `origin` in a fork clone, or `band`
when the on-ramp bootstrap layered Band onto an existing checkout — then fetch both
refs with explicit refspecs and **echo the source** so provenance is visible (this
is the source the operator approved in step 2 above):

```bash
FORK_URL="${NANOCLAW_REPO:-https://github.com/band-ai/nanoclaw-band}"
FORK_REMOTE=$(git remote -v | awk '$2 ~ /nanoclaw-band/ {print $1; exit}')
[ -n "$FORK_REMOTE" ] || { git remote add band "$FORK_URL"; FORK_REMOTE=band; }
echo "Band source: $(git remote get-url "$FORK_REMOTE")  (remote: $FORK_REMOTE — payload: band/adapter, skill: main)"
# Explicit refspecs create refs/remotes/$FORK_REMOTE/{band/adapter,main}. A bare
# `git fetch $FORK_REMOTE band/adapter` only writes FETCH_HEAD on shallow /
# single-branch clones (the bootstrap case), leaving the ref the copy step reads
# unresolved.
git fetch "$FORK_REMOTE" \
  "+refs/heads/band/adapter:refs/remotes/$FORK_REMOTE/band/adapter" \
  "+refs/heads/main:refs/remotes/$FORK_REMOTE/main"
```

If the fetch fails, the fork remote is wrong or unreachable — the URL above is the
canonical source. Keep `$FORK_REMOTE` and `$ROOT` set for the copy below (same
shell).

### 2. Copy the Band files in (repo-root anchored, then validated)

The full tested set is 14 files (adapter, config, two channel migrations, the
container MCP tool + memory hooks + lifecycle registration, and their tests). Copy
them and **immediately validate** against the branch, so a wrong cwd or partial
copy is caught now, not three steps later:

```bash
FILES="
src/channels/band.ts
src/channels/band.test.ts
src/modules/band-config.ts
src/db/migrations/module-band-state.ts
src/db/migrations/020-band-rename.ts
container/agent-runner/src/mcp-tools/band.ts
container/agent-runner/src/mcp-tools/band.test.ts
container/agent-runner/src/mcp-tools/band.instructions.md
container/agent-runner/src/band-lifecycle.ts
container/agent-runner/src/band-lifecycle.test.ts
container/agent-runner/src/band-memory-load.ts
container/agent-runner/src/band-memory-load.test.ts
container/agent-runner/src/band-memory-consolidate.ts
container/agent-runner/src/band-memory-consolidate.test.ts
"
for f in $FILES; do
  mkdir -p "$ROOT/$(dirname "$f")"
  git show "$FORK_REMOTE/band/adapter:$f" > "$ROOT/$f"
done

# Validate: every file present at the repo root and byte-identical to the branch.
bad=0
for f in $FILES; do
  test -s "$ROOT/$f" || { echo "MISSING/EMPTY: $f"; bad=1; continue; }
  [ "$(git hash-object "$ROOT/$f")" = "$(git rev-parse "$FORK_REMOTE/band/adapter:$f")" ] \
    || { echo "MISMATCH: $f"; bad=1; }
done
[ "$bad" = 0 ] && echo "copy: 13/13 present and byte-identical" || echo "copy: FAILED — do not proceed"
```

(This is the first of the two approval gates from **Before you start** — the
classifier may hold the `git show` copy. Surface it; don't work around it.)

`src/channels/band.ts` registers the two Band channel migrations on import
(`registerChannelMigrations('band', [...])`), so the copied files carry their own
migration wiring — **do not** edit the core migration barrel.

### 3. Append the three self-registration imports (skip any already present)

`src/channels/index.ts` — host channel adapter:

```typescript
import './band.js';
```

`container/agent-runner/src/mcp-tools/index.ts` — room-scoped `band_*` tools:

```typescript
import './band.js';
```

`container/agent-runner/src/index.ts` — start/stop lifecycle hooks. Place it
**immediately after** the `import './providers/index.js';` line (so providers
register first) and **before** the `import { createProvider ... }` line that
follows the placement-comment block:

```typescript
import './band-lifecycle.js';
```

### 4. Install the pinned dependencies

Exact versions only (never a range, per the supply-chain policy). The host needs
the SDK and the REST client; the agent-runner container tree needs the SDK only:

```bash
pnpm add @band-ai/sdk@0.1.6 @band-ai/rest-client@0.0.121
( cd "$ROOT/container/agent-runner" && bun add @band-ai/sdk@0.1.6 )
```

(Second approval gate from **Before you start** — the classifier may hold the
`@band-ai/*` install. Surface it; don't work around it.)

> `@band-ai/sdk@0.1.6` still exports its link class under the **pre-rename** name
> `ThenvoiLink`. The host adapter imports it as `ThenvoiLink as BandLink`; the
> container modules import `ThenvoiLink` directly (plus `AgentTools` from
> `@band-ai/sdk/runtime`). This is expected — do not "fix" it to a `BandLink`
> export the published package does not have. [VERIFY.md](VERIFY.md) step 2 guards
> against version skew here.

### 5. Build host + container

```bash
( cd "$ROOT" && pnpm run build )
( cd "$ROOT" && ./container/build.sh )
```

The base channel needs no python3 and no band-mcp. Rebuilding the image lets the
agent-runner overlay pick up the copied container files.

### 6. Verify

Run [VERIFY.md](VERIFY.md). At minimum:

```bash
( cd "$ROOT" && pnpm test -- src/channels/band.test.ts )
( cd "$ROOT/container/agent-runner" && bun test src/mcp-tools/band.test.ts src/band-lifecycle.test.ts )
```

## Bring Band online (end-to-end)

After build + verify pass, drive the operator from credentials to a live, wired
Band agent. **Do every step you can yourself**; hand the operator only the
human-only actions named in **Before you start**. Carry the flow through to a
message round-trip — don't stop at the build.

### Step 1 — Credentials (detect → skip / register / rotate)

The host adapter reads an **agent-scoped** key from `.env`. **`register-agent.sh`
is not idempotent — each run mints a brand-new Band agent (new id + key).** So
gate on an existing key (Phase 0 already told you which case you're in):

- **Key present → skip to Step 2.** Do not re-run the script; it would create a
  duplicate agent. (If `.env` has a key but no `BAND_AGENT_ID`, add the matching
  id rather than re-registering — the host needs both. To rotate or replace a dead
  key, see *Re-register or rotate* at the end of this step.)

- **Key missing → register one.** This needs a **create-scope** Band API key
  (app.band.ai → Settings → API Keys), used only to mint the agent. The operator
  pastes it at the prompt — never on `argv`, never `eval` the create-scope key:

  ```bash
  ( umask 077; "$ROOT/.claude/skills/add-band/scripts/register-agent.sh" > /tmp/band-agent.env )
  # writes:  BAND_AGENT_ID=<uuid>   and   BAND_AGENT_API_KEY=<agent-scoped key>
  ```

  Then route the agent key to **both** places it's needed:

  1. **`.env` (host).** Upsert both lines into `.env` (don't duplicate keys). The
     host adapter reads `BAND_AGENT_API_KEY` directly to open the Band WebSocket +
     REST client (`src/modules/band-config.ts` → `src/channels/band.ts`); without
     it `getBandConfig()` returns null and the channel never starts.
     `BAND_AGENT_API_KEY` is canonical; legacy `BAND_API_KEY` / `THENVOI_*` still
     work, with `BAND_*` taking precedence.

  2. **OneCLI vault (container).** For hosted `app.band.ai` the container never
     gets the raw key — OneCLI injects the `X-API-Key` header on egress. Store the
     same key in the vault, reading it back from `.env` (never paste it). Band
     authenticates with **`X-API-Key`**, not `Authorization: Bearer`:

     ```bash
     KEY=$(grep -E '^(BAND|THENVOI)_(AGENT_)?API_KEY=' .env | head -1 | cut -d= -f2-)
     onecli secrets create --name Band --type generic --value "$KEY" \
       --host-pattern app.band.ai --header-name X-API-Key --value-format '{value}'
     ```

     The agent's OneCLI `secretMode` must be `all` (or assign this secret to it).

  Wipe the temp file regardless of path — it holds the live key:

  ```bash
  rm -f /tmp/band-agent.env
  ```

Optional vars, all defaulted (leave unset for hosted Band):

```bash
# BAND_BASE_URL   defaults to https://app.band.ai
# BAND_OWNER_ID   Band user UUID that owns the agent; falls back to GET /agent/me
```

Memory pre-load/consolidation and contact-event handling are off by default
([reference/configuration.md](reference/configuration.md)). If this instance
mirrors env, sync it: `[ -f data/env/env ] && cp .env data/env/env`.

#### Re-register or rotate the key

The skip-on-existing-key gate assumes the key in `.env` is live. Two resets:

- **Rotate, same agent** — you regenerated the key on Band; the agent still
  exists. Put the new key in `.env` (`BAND_AGENT_API_KEY`), then point the vault
  secret at it — no new agent is minted:

  ```bash
  onecli secrets list                 # find the "Band" secret id
  onecli secrets update --id <secret-id> --value "$NEW_KEY" \
    --host-pattern app.band.ai --header-name X-API-Key --value-format '{value}'
  ```

- **Dead agent → mint fresh** — you deleted the agent on Band (the `.env` key is
  now invalid). The stale key would make the gate skip forever, so clear it
  everywhere, then re-run Step 1:

  ```bash
  sed -i.bak -E '/^(BAND|THENVOI)_(AGENT_ID|AGENT_API_KEY|API_KEY)=/d' .env && rm -f .env.bak
  [ -f data/env/env ] && cp .env data/env/env
  onecli secrets delete --id <secret-id>   # id from `onecli secrets list`
  ```

### Step 2 — Rebuild the image if it's stale

The agent image is slug-scoped and must contain the Band container files **and the
`@band-ai/sdk` dependency**. This matters more than it looks: the container MCP
barrel imports `band.js` unconditionally, and `band.ts` imports `@band-ai/sdk` at
module load — so a missing dep throws and the **entire MCP server fails to start,
killing every tool on every session** (Band, CLI, Telegram, and core), not just the
`band_*` tools. The agent still chats (the text reply path needs no MCP) but
silently has zero tools. Rebuild, then **verify the dep actually landed** —
`package.json` having it does not prove the image does (the image may predate the
install, or buildkit may serve a stale COPY layer; see "Container Build Cache" in
CLAUDE.md):

```bash
IMAGE="$(container_image_base):latest"
( cd "$ROOT" && ./container/build.sh )

# Verify the rebuild installed the SDK; prune the builder and retry if not.
if docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/node_modules/@band-ai/sdk' >/dev/null 2>&1; then
  echo "ok: image contains @band-ai/sdk"
else
  echo "STALE: image lacks @band-ai/sdk — pruning builder cache and rebuilding"
  docker builder prune -f
  ( cd "$ROOT" && ./container/build.sh )
fi
```

(Phase 1 Step 5 already built it on a fresh install; this guards the
already-installed / re-run path, where the live image may predate the Band files.)

### Step 3 — Restart **this checkout's** service so it discovers rooms

You never enter room IDs by hand: on start, the adapter connects and writes every
room the agent can see into `messaging_groups`. Restart the service **for this
checkout** — the label is slug-scoped (`com.nanoclaw-v2-<slug>`), so never assume
a bare `com.nanoclaw`, and never `pnpm run dev` while a service holds the webhook
port (instant `EADDRINUSE`):

```bash
"$ROOT/scripts/safe-restart.sh"
```

This restarts the checkout's launchd/systemd service and, if the restart trips
the upgrade tripwire (expected on an old install — see **Before you start**
point 4 and Phase 0's `upgrade tripwire` check above), stamps the marker and
retries once automatically. If it still fails, it stops and tells you to
investigate `logs/nanoclaw.error.log` by hand — don't clear the marker yourself
at that point. If there's no service for this checkout, it says so and falls back
to the same guidance as before: run `/setup`, or for dev, set a free
`WEBHOOK_PORT` in `.env` and run `pnpm run dev`.

If you fall back to `pnpm run dev` and it fails with `EADDRINUSE`, the default port
3000 is taken (a known collision with band-prototype) — set `WEBHOOK_PORT=3100`
(or any free port) in `.env` and retry.

A service restart does **not** kill already-running session containers — they keep
serving the **old** image until their 30-min ceiling. If you rebuilt in Step 2 while
sessions were live, clear them so they respawn from the new image:

```bash
ncl groups restart --id <agent-group-id>   # repeat per Band-wired agent group
```

### Step 4 — Confirm discovery

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, platform_id, name FROM messaging_groups WHERE channel_type='band'"
```

- **Rows present** → Step 5.
- **No rows** → the agent is in no rooms yet. With an owner set, the adapter
  auto-provisions a **Nano Hub** direct room on first connect; otherwise ask the
  operator to add the agent to a Band room (or DM it) at app.band.ai, then re-run.
  Discovery is event-driven — allow a few seconds after the room appears.

### Step 5 — Wire a room

Discovery does **not** wire a room to an agent. **Invoke `/manage-channels`** — it
routes to `/init-first-agent` when no owner / agent group exists yet, and
otherwise asks the isolation question and writes the wiring row. The Band answers
it needs:

- **channel / type**: `band`
- **platform ID**: `band:<room-id>` (a row from Step 4)
- **session mode**: `shared` for room-local conversations; `agent-shared` only
  when intentionally merging multiple surfaces into one session
- **isolation**: same agent group for your own rooms; a separate agent group for
  rooms with different people, projects, or data boundaries

When the target agent group already exists, wire non-interactively instead. All
three of `--platform-id`, `--name`, `--folder` are **required** (the register step
exits with code 4 otherwise):

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "band:<room-id>" --name "<room display name>" \
  --folder "<agent-folder>" --channel "band" \
  --session-mode "shared" --assistant-name "<assistant name>"
```

**Then always ensure the reply destination + restart (do not skip — run this every
install).** Wiring routes inbound, but the agent can only **reply** to a room it has
a **destination** for. `setup register` creates that destination automatically; raw
`ncl wirings create` does **not**. With no Band destination the formatter's
reply-target lookup (`findByRouting(channelType, platformId)` in
`container/agent-runner/src/destinations.ts`) finds nothing, so the agent replies on
whatever other destination it has (e.g. a Telegram DM) and the reply never reaches
Band — usually with a `No adapter for channel type` warning if that channel isn't
loaded here. So after wiring, verify-and-create the destination (idempotent), then
restart so the system-prompt destination list rebuilds (it is built once at spawn —
`destinations.ts:82`):

```bash
AGID="<agent-group-id>"; BAND_MG="<band-messaging-group-id>"   # the Step 4 room row
ncl destinations list --agent-group-id "$AGID" | grep -q "$BAND_MG" \
  || ncl destinations add --agent-group-id "$AGID" --local-name band-hub \
       --target-type channel --target-id "$BAND_MG"
ncl groups restart --id "$AGID"   # respawns with the Band destination in its prompt
```

### Step 6 — Recognize the owner's Band identity (ask the access level)

Wiring routes the room, but a sender still has to clear the agent group's **access
gate**. When Band is added to an install that **already has an owner on another
channel** (e.g. Telegram), the owner's *Band* identity — `band:<owner-uuid>` — is a
brand-new platform id with **no role and no membership**, so their first Band
message is dropped:

```
MESSAGE DROPPED — unknown sender (approval requested)  userId="band:<uuid>"  accessReason="not_member"
```

(The unknown-sender approval fallback can't even reach them if that other channel's
adapter isn't loaded in this checkout.)

Resolve the owner's Band UUID — try, in order:

```bash
grep -oE 'ownerId="[0-9a-f-]+"' logs/nanoclaw.log | tail -1   # hub-creation log line
grep -E '^BAND_OWNER_ID=' .env                                # or explicit env
ncl users list | grep '^band:'                                # or the auto-registered band: user
```

(A `band:` user row auto-appears the instant a message arrives — **even when it was
dropped** — so after a failed first attempt the identity is already in `ncl users
list`.)

Check whether that identity already has a role or membership; if not, **ask the
operator what level to grant** (AskUserQuestion) — exactly as `/init-first-agent`
does for the first channel:

- **owner** — global, full control. The right default when it's the operator's own
  hub. `ncl roles grant --user "band:<uuid>" --role owner`
- **admin** — manage groups + approve actions; global, or `--agent-group-id <id>`
  to scope. `ncl roles grant --user "band:<uuid>" --role admin [--agent-group-id <id>]`
- **member** — least privilege; this group only, no admin.
  `ncl members add --user "band:<uuid>" --group <agent-group-id>`

> The role/member verbs take `--user` / `--group` (**not** `--user-id` /
> `--agent-group-id`, despite the field list those verbs print).

A message that was **already dropped is not reprocessed** — have the operator send a
fresh one after the grant.

### Step 7 — Verify end-to-end

With the room wired and the service running, send a message in that Band room
(mention the agent if it's mention-gated). It should reply within a few seconds.
If it stays silent, trace the round trip with the schema-correct queries in
[VERIFY.md](VERIFY.md) step 8 and the **Troubleshooting** section below.

## Outbound origination: Band MCP (optional, advanced)

The native `band_*` tools are room-scoped — they act inside a Band room the agent
already serves, and cover the entire base channel (receive + reply). No band-mcp
is needed for that, and the base install adds nothing to the Dockerfile.

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

## Upgrading / staying in sync

Skill and payload both come from the fork but from **two different refs** (Phase 1
step 1) — keep them straight:

| What | Source ref | Why |
|------|-----------|-----|
| This skill (`.claude/skills/add-band/`) | fork `main` | Canonical home of the skill. |
| The Band payload (`src/…`, `container/…`) | fork `band/adapter` | Branch with Band inlined; `main` is Band-free. |

Prefer `main` for the skill:

1. **It's authoritative.** `band/adapter` only mirrors the skill from `main` via the
   sync workflow and can lag a few minutes behind a `main` push — so the fork's
   `main` is strictly fresher for skill files.
2. **It keeps the model clean:** skill ← `main`, payload ← `band/adapter`. Pulling
   the skill from `band/adapter` "because it has everything" conflates the two and
   quietly depends on the mirror being current.

Resolve the fork remote (same as Phase 1 step 1), refresh the skill, then re-run it
— every step is idempotent, so it re-copies the payload from `band/adapter` and
reinstalls the pinned deps:

```bash
FORK_REMOTE=$(git remote -v | awk '$2 ~ /nanoclaw-band/ {print $1; exit}')
[ -n "$FORK_REMOTE" ] || { git remote add band https://github.com/band-ai/nanoclaw-band; FORK_REMOTE=band; }
git fetch "$FORK_REMOTE" "+refs/heads/main:refs/remotes/$FORK_REMOTE/main"
git checkout "$FORK_REMOTE/main" -- .claude/skills/add-band/
```

**Merge conflict in the skill paths.** If an upstream merge (e.g. `/update-nanoclaw`)
conflicts inside `.claude/skills/add-band/`, do **not** hand-resolve it — the skill
files are the installer, not user data, so there is nothing to preserve. Take the
fork's version wholesale, exactly like the payload copy step does:

```bash
git checkout "$FORK_REMOTE/main" -- .claude/skills/add-band/   # take theirs, skill paths only
```

Deterministic, conflict-proof, and consistent with the copy-not-merge philosophy the
payload install already uses.

## Troubleshooting

Messages appear in Band but the agent stays silent → the room is discovered but
not wired:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, channel_type, platform_id, name FROM messaging_groups WHERE channel_type='band'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT messaging_group_id, agent_group_id, session_mode FROM messaging_group_agents"
```

Your Band message is dropped — `MESSAGE DROPPED — unknown sender` /
`accessReason="not_member"` in the logs → the sender's Band identity
(`band:<uuid>`) has no role or membership on the wired agent group. Common when an
owner already exists on another channel: their Band identity is a separate platform
id. Grant access per **Step 6**, then resend (dropped messages are not reprocessed).

Agent replies but nothing shows up in Band — often paired with a
`No adapter for channel type` warning and an outbound row whose `channel_type` is
some *other* channel (e.g. `telegram`) → the agent group has no **destination** for
the Band room, so its reply routed elsewhere. Add the destination and restart per
the destination block in **Step 5**. Confirm with:

```bash
ncl destinations list --agent-group-id <agent-group-id>   # expect a target_type=channel row for the Band messaging group
```

Tools missing inside the container → confirm the session is Band-backed, that the
image was rebuilt after the copy (Step 2), and that
`container/agent-runner/src/mcp-tools/index.ts` imports `./band.js`.

Memory tools return disabled/unavailable → leave them disabled for that run; do
not claim memory was stored unless a `band_store_memory` call succeeded.

To uninstall, see [REMOVE.md](REMOVE.md). To smoke-test, see [VERIFY.md](VERIFY.md).
