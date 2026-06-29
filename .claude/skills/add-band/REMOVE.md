# Remove Band

Band installs additively (copied files + three import lines + the SDK deps), so
removal is the install in reverse. No merge to revert.

## 1. Delete the copied Band files

```bash
rm -f \
  src/channels/band.ts \
  src/channels/band.test.ts \
  src/modules/band-config.ts \
  src/db/migrations/module-band-state.ts \
  src/db/migrations/020-band-rename.ts \
  container/agent-runner/src/mcp-tools/band.ts \
  container/agent-runner/src/mcp-tools/band.test.ts \
  container/agent-runner/src/mcp-tools/band.instructions.md \
  container/agent-runner/src/band-lifecycle.ts \
  container/agent-runner/src/band-lifecycle.test.ts \
  container/agent-runner/src/band-memory-load.ts \
  container/agent-runner/src/band-memory-load.test.ts \
  container/agent-runner/src/band-memory-consolidate.ts \
  container/agent-runner/src/band-memory-consolidate.test.ts
```

## 2. Remove the three self-registration import lines

Delete (do not comment out) each line:

- `src/channels/index.ts` — `import './band.js';`
- `container/agent-runner/src/mcp-tools/index.ts` — `import './band.js';`
- `container/agent-runner/src/index.ts` — `import './band-lifecycle.js';`

The Band channel migrations were registered by the now-deleted `band.ts`
(`registerChannelMigrations`), so removing the file un-wires them automatically —
there is no core migration-barrel edit to revert.

## 3. Uninstall the dependencies

```bash
pnpm remove @band-ai/sdk @band-ai/rest-client
cd container/agent-runner && bun remove @band-ai/sdk && cd -
```

## 4. Credentials, image, restart

1. Remove `BAND_*` (and any legacy `THENVOI_*`) lines from `.env` (and
   `data/env/env` if you mirror it there). If you had enabled the optional
   outbound-origination Band MCP, also revert the Dockerfile edits from
   `reference/configuration.md` and remove the `band` entry from the relevant
   agent group's `container.json`.
2. Rebuild and restart:
   ```bash
   pnpm install --frozen-lockfile && pnpm run build
   ./container/build.sh
   # macOS:  launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   # Linux:  systemctl --user restart nanoclaw
   ```

The Band channel migrations leave a `module_state` table behind; it is inert once
the adapter is gone and harmless to leave. Wired Band rooms remain as inert rows
in `messaging_groups` / `messaging_group_agents` — delete them via
`/manage-channels` if you want a clean DB.
