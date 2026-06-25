# Verify Band

## 1. Builds are clean (host + container)

```bash
pnpm run build
cd container/agent-runner && bun run typecheck && cd -
```

A clean build is the strongest SDK-resolution check. `src/channels/band.ts`
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

The lifecycle import in `container/agent-runner/src/index.ts` must sit **after**
`import './providers/index.js';` and **before** the `runStartHooks(...)` call —
confirm by eye if any of these moved.

## 5. The Band channel migrations register themselves

The two Band migrations must be wired by `band.ts` on import (not by the core
barrel):

```bash
grep -q "registerChannelMigrations" src/channels/band.ts && echo "migrations: self-registered"
test -f src/db/migrations/module-band-state.ts && test -f src/db/migrations/020-band-rename.ts && echo "migration files: present"
```

## 6. Adapter is credentialed

```bash
grep -qE '^(BAND|THENVOI)_AGENT_ID=' .env && echo "creds: present"
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

Confirm the round trip in the session DBs if it doesn't:

```bash
# Did the message reach the container?
#   data/v2-sessions/<agent-group>/<session>/inbound.db  -> messages_in
# Did the agent produce a reply?
#   data/v2-sessions/<agent-group>/<session>/outbound.db -> messages_out
```
