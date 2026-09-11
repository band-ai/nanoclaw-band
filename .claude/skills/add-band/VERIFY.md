# Verify Band

Anchor to the repo root and source the slug helper first — the service/image
checks below derive this checkout's slug-scoped names from it:

```bash
cd "$(git rev-parse --show-toplevel)"; export PROJECT_ROOT="$PWD"
source setup/lib/install-slug.sh   # launchd_label / systemd_unit / container_image_base
```

## 0. The agent image actually contains the Band files + SDK

A slug-scoped image built **before** the Band files were copied — or before
`@band-ai/sdk` was installed — breaks the container. The MCP barrel imports
`band.js` unconditionally and `band.ts` imports `@band-ai/sdk` at load, so a missing
dep throws and crashes the **whole MCP server** (every tool on every session, not
just `band_*`); the agent still chats but has no tools. The build date alone is not
enough — verify the image's contents directly:

```bash
IMAGE="$(container_image_base):latest"

# exists + build date
docker inspect "$IMAGE" --format 'image {{.Id}} built {{.Created}}' 2>/dev/null \
  || echo "image $IMAGE absent — rebuild with ./container/build.sh"

# (a) the SDK is actually installed in the image
docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/node_modules/@band-ai/sdk' >/dev/null 2>&1 \
  && echo "ok: image has @band-ai/sdk" || echo "FAIL: stale image — rebuild (./container/build.sh)"

# (b) the band tool module loads in-image (src mounted as at runtime)
docker run --rm \
  -v "$PWD/container/agent-runner/src:/app/src:ro" \
  -e BAND_AGENT_ID=smoke -e BAND_REST_URL=https://app.band.ai -e BAND_API_KEY=smoke \
  --entrypoint sh "$IMAGE" \
  -c 'cd /app && bun -e "await import(\"./src/mcp-tools/band.ts\"); console.log(\"BAND_TOOLS_IMPORT_OK\")"'
```

Expect `BAND_TOOLS_IMPORT_OK`. A "Cannot find module" means the image predates the
dependency — rebuild.

## 1. Builds are clean (host + container)

```bash
pnpm run build
cd container/agent-runner && bun run typecheck && cd -
```

A clean build proves the **source** typechecks and the **host** tree resolves the
SDK — but not that the built image installed it (that is §0, and the agent runs in
the image, not the host tree). `src/channels/band.ts`
imports the link class as `ThenvoiLink as BandLink` from `@band-ai/sdk`, and the
container modules (`mcp-tools/band.ts`, `band-memory-load.ts`,
`band-memory-consolidate.ts`) import `ThenvoiLink` from `@band-ai/sdk` plus
`AgentTools` from `@band-ai/sdk/runtime`. If the installed package doesn't export
those, the build/typecheck fails here.

## 2. @band-ai/sdk exports the link class under the pre-rename name

Guards against version skew. Published `@band-ai/sdk@0.1.6` exports the class as
`ThenvoiLink` (not `BandLink`). The host adapter aliases it locally
(`ThenvoiLink as BandLink`); the package itself must still export `ThenvoiLink`:

```bash
node -e "const m = require('@band-ai/sdk'); if (typeof m.ThenvoiLink !== 'function') { console.error('FAIL: @band-ai/sdk does not export ThenvoiLink (got: ' + Object.keys(m).join(', ') + ')'); process.exit(1); } console.log('ok: @band-ai/sdk exports ThenvoiLink');"
```

If this fails, the installed `@band-ai/sdk` version is incompatible with the
imports in the Band files — re-pin to a version that exports `ThenvoiLink`
(0.1.6) or update the imports in `band.ts`, `mcp-tools/band.ts`,
`band-memory-load.ts`, and `band-memory-consolidate.ts`.

## 3. Dependencies are pinned in both trees

```bash
grep -E '"@band-ai/(sdk|rest-client)"' package.json                 # host: sdk@0.1.6 + rest-client@0.0.121
grep -E '"@band-ai/sdk"' container/agent-runner/package.json        # container: sdk@0.1.6
```

## 4. The three self-registration imports are present

```bash
grep -q "import './band.js';" src/channels/index.ts && echo "host channel: registered"
grep -q "import './band.js';" container/agent-runner/src/mcp-tools/index.ts && echo "container tools: registered"
grep -q "import './band-lifecycle.js';" container/agent-runner/src/index.ts && echo "container lifecycle: registered"
```

The lifecycle import in `container/agent-runner/src/index.ts` must sit
**immediately after** `import './providers/index.js';` and **before** the
`import { createProvider ... }` line that follows the placement-comment block —
confirm by eye if any of these moved.

## 5. The Band channel migrations register themselves

The two Band migrations must be wired by `band.ts` on import (not by the core
barrel):

```bash
grep -q "registerChannelMigrations" src/channels/band.ts && echo "migrations: self-registered"
test -f src/db/migrations/module-band-state.ts && test -f src/db/migrations/020-band-rename.ts && echo "migration files: present"
```

## 6. Adapter is credentialed (host .env + container vault)

Two independent credential paths must both be satisfied. The host adapter reads the
key from `.env`; the in-container `band_*` tools reach Band through the OneCLI
gateway, which injects the key **only when a vault secret's host pattern matches the
egress host** (`BAND_BASE_URL`, default `app.band.ai`). A missing secret — or a
legacy Thenvoi-era one on `app.thenvoi.com` — makes every `band_*` call silently
401 while the host adapter still looks healthy.

```bash
grep -qE '^(BAND|THENVOI)_AGENT_ID=' .env && echo "host creds: present"

HOST=$(printf '%s' "${BAND_BASE_URL:-${THENVOI_BASE_URL:-https://app.band.ai}}" | sed -E 's#^https?://##; s#/.*##')
onecli secrets list | HOST="$HOST" python3 -c '
import os, sys, json, re
host = os.environ["HOST"]
secrets = [s for s in json.load(sys.stdin).get("data", [])
           if re.search(r"band|thenvoi", s.get("name") or "", re.I)
           or re.search(r"app\.(band\.ai|thenvoi\.com)", s.get("hostPattern") or "")]
if not secrets:
    print("FAIL: no Band vault secret — band_* tools will 401 (see Step 1, OneCLI vault)")
elif all((s.get("hostPattern") or "") != host for s in secrets):
    have = ", ".join((s.get("hostPattern") or "<none>") for s in secrets)
    print(f"FAIL: Band secret host pattern != {host} (have: {have}) — band_* tools will 401")
else:
    print(f"ok: Band vault secret targets {host}")
'
```

## 7. A room is wired (not just discovered)

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, platform_id, name FROM messaging_groups WHERE channel_type='band'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT messaging_group_id, agent_group_id, session_mode FROM messaging_group_agents"
```

A row in the first query with **no** matching `messaging_group_id` in the second
is discovered but unwired — run `/manage-channels`.

## 8. End-to-end

With the service running, send a message in a wired Band room (mention the agent
if the room is mention-gated). The agent should respond within a few seconds.

Confirm the round trip in the session DBs if it doesn't. Pick the most recent
session, then read both DBs (these column names are current — `messages_in` has
no `user_id` column; the sender is inside the JSON `content`):

```bash
SDIR=$(ls -td data/v2-sessions/ag-*/ 2>/dev/null | head -1)
SESS=$(ls -td "$SDIR"sess-*/ 2>/dev/null | head -1)

# Did the message reach the container? (inbound.db -> messages_in)
pnpm exec tsx scripts/q.ts "${SESS}inbound.db" \
  "SELECT seq, kind, status, channel_type, content FROM messages_in ORDER BY seq DESC LIMIT 5"

# Did the agent produce a reply? (outbound.db -> messages_out)
pnpm exec tsx scripts/q.ts "${SESS}outbound.db" \
  "SELECT seq, kind, channel_type, content FROM messages_out ORDER BY seq DESC LIMIT 5"
```

An inbound row but no outbound reply → the container received it but produced
nothing (check `logs/nanoclaw.error.log`). No inbound row → routing/wiring issue
(re-check step 7).
