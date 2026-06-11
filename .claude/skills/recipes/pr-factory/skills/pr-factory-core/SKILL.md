---
name: pr-factory-core
description: PR Factory component — the engine. GitHub pull_request webhook → per-PR Slack thread + worker agent session (triage/review/test-plan via default group instructions), supervisor bootstrap with skill-edit approval flow, send-to-testing approval gate, test-result coordination, pr_threads index, and four container MCP tools. Ships seams for the optional gh-action-approval, vm-test-orchestrator, and slack-canvas components.
---

# pr-factory-core (PR Factory component)

The PR Factory engine, as a host module (`src/modules/pr-factory/`) plus a container MCP-tool module:

- **GitHub webhook** (`webhook.ts`) — mounts `/webhook/github` on core's shared webhook server via `registerWebhookHandler`, verifies HMAC-SHA256 (`GITHUB_WEBHOOK_SECRET`), filters `pull_request` events (opened / synchronize / closed / ready_for_review / converted_to_draft).
- **Per-PR sessions** (`handler.ts`) — each opened PR gets a Slack thread (posted by the worker bot), a `pr_threads` row, and a per-thread session under the **PR Factory Worker** agent group, seeded with the diff and a `[PR_CONTEXT: …]` trigger. `synchronize` kills + re-creates the session in the same thread. GitHub reads ride the OneCLI gateway proxy when available (vault-stored PAT, never an env var) and fall back to direct unauthenticated calls.
- **Bootstrap** (`bootstrap.ts`) — idempotent, self-correcting setup: worker agent group (default triage/review/test-plan instructions seeded into `groups/pr-factory-worker/CLAUDE.local.md`), default-instance worker messaging group, optional supervisor agent group with `slack-supervisor`-instance messaging groups (admin channel + PR channel), and a `slack-tester`-instance messaging group when the operator-created `pr-tester` agent group exists.
- **Approval flows** — send-to-testing (`testing-approval.ts`, plan file → card → human gate), retry-after-failure, and supervisor skill edits (`skill-edit-approval.ts`, diff preview → card → write on approve). One active card per thread (`dismiss-approvals.ts`); a 👀 reaction marks awaiting-approval threads and clears on resolution — the reject path is observed through core's `registerApprovalResolvedHandler` hook.
- **Coordination** (`orchestrator.ts`) — wakes the tester agent when a VM is ready, enforces a 30-minute run timeout, posts results, wakes the worker to propose merge (PASS) or analyze (FAIL/PARTIAL).
- **Container MCP tools** (`container/agent-runner/src/mcp-tools/pr-factory.ts`) — `propose_skill_edit`, `send_to_testing`, `credentialed_gh`, `submit_test_results`. Each emits a `pr_*` system action via messages_out; the host module registers the four matching delivery actions.

Inert without `GITHUB_WEBHOOK_SECRET`: the module loads (approval handlers bind) but registers no delivery actions and mounts no webhook.

## Component seams (cross-component contract)

Core degrades gracefully where a sibling component owns the capability. Keep these exports stable — the named components register against them at import time:

| Seam (core file) | Exports | Registered by | Without it |
|---|---|---|---|
| `gh-action.ts` | `setGhActionHandler`, `GhActionHandler` | `gh-action-approval` | `credentialed_gh` calls notify the agent that the component is missing |
| `test-orchestration.ts` | `registerTestOrchestrator`, `TestOrchestratorModule`, `TestRun`, `OrchestratorCallbacks` | `vm-test-orchestrator` | approved test plans answer "no test orchestrator installed"; orchestrator init is skipped |
| `canvas.ts` | `registerCanvasProvider`, `createCanvas`, `CanvasResult` | `slack-canvas` | test plans/results post as plain text + `.md` file upload |

Core also imports `SUPERVISOR_INSTANCE` / `TESTER_INSTANCE` from the `slack-bots` component's adapters — that component must be applied first.

Integration surface: one appended line in `src/modules/index.ts`, one inserted line in `container/agent-runner/src/mcp-tools/index.ts`, one import + array entry in `src/db/migrations/index.ts`, a four-helper append in `src/db/sessions.ts`, and one pinned dependency (`undici`). Everything else is added files.

## Prerequisites

Probe each before applying; stop on a failed probe and do what it names first.

1. **`/add-slack` is applied** (worker bot):

   ```bash
   test -f src/channels/slack.ts && echo OK
   ```

   If it fails: run `/add-slack`, then return here.

2. **The `slack-bots` component is applied** (instance constants this module imports):

   ```bash
   grep -q "SUPERVISOR_INSTANCE = 'slack-supervisor'" src/channels/slack-supervisor.ts \
     && grep -q "TESTER_INSTANCE = 'slack-tester'" src/channels/slack-tester.ts && echo OK
   ```

   If it fails: apply the `slack-bots` component first.

3. **Core ships the approval-resolved hook**:

   ```bash
   grep -q 'registerApprovalResolvedHandler' src/modules/approvals/primitive.ts && echo OK
   ```

   If it fails: **stop — core is missing the approval-resolved hook; update to nanoclaw ≥ 2.1.11 first.** This skill makes no core edits to substitute for it.

4. **Core ships the delivery-action getter**:

   ```bash
   grep -q 'export function getDeliveryAction' src/delivery.ts && echo OK
   ```

   If it fails: **stop — core is missing the delivery-action getter; update to nanoclaw ≥ 2.1.11 first.**

5. **Core ships the raw webhook registry**:

   ```bash
   grep -q 'export function registerWebhookHandler' src/webhook-server.ts && echo OK
   ```

   If it fails: **stop — core is missing the raw webhook registry; update to nanoclaw ≥ 2.1.11 first.** This skill mounts `/webhook/github` through that registry and makes no webhook-server edits.

6. **Core ships the channel-instance substrate**:

   ```bash
   test -f src/db/migrations/016-messaging-group-instance.ts && echo OK
   ```

   If it fails: **stop — core is missing the channel-instance substrate; update to nanoclaw ≥ 2.1.11 first.**

Each step below is idempotent: if the file already contains the patched form, leave it as is and continue.

## Apply

All copy sources are under this component's folder; run every command from the repo root:

```bash
SKILL=.claude/skills/recipes/pr-factory/skills/pr-factory-core
```

### 1. Copy the host module

```bash
mkdir -p src/modules/pr-factory
for f in index bootstrap handler webhook orchestrator testing-approval skill-edit-approval \
         dismiss-approvals reactions activity-log defaults supervisor \
         worker-instructions canvas test-orchestration gh-action; do
  cp $SKILL/files/src/modules/pr-factory/$f.ts src/modules/pr-factory/$f.ts
done
```

### 2. Copy the DB layer

```bash
cp $SKILL/files/src/db/pr-threads.ts src/db/pr-threads.ts
cp $SKILL/files/src/db/migrations/module-pr-factory-pr-threads-v2.ts src/db/migrations/module-pr-factory-pr-threads-v2.ts
```

### 3. Register the migration (`src/db/migrations/index.ts`)

**3a.** Append to the import block:

```typescript
import { modulePrFactoryPrThreadsV2 } from './module-pr-factory-pr-threads-v2.js';
```

**3b.** Append `modulePrFactoryPrThreadsV2,` as the **last** entry of the `migrations` array. The migration name carries a `-v2` suffix deliberately: the runner dedupes by name, and installs upgraded from the legacy bot_id substrate already have `'module-pr-factory-pr-threads'` recorded — the new name is what makes the bot_id-column drop run there. Never rename it back.

### 4. Append the pending-approvals helpers (`src/db/sessions.ts`)

Insert after `getPendingApprovalsByAction` (skip any helper already present):

```typescript
export function getPendingApprovalsBySessionAction(sessionId: string, action: string): PendingApproval[] {
  return getDb()
    .prepare('SELECT * FROM pending_approvals WHERE session_id = ? AND action = ?')
    .all(sessionId, action) as PendingApproval[];
}

export function getPendingApprovalsBySession(sessionId: string): PendingApproval[] {
  return getDb()
    .prepare('SELECT * FROM pending_approvals WHERE session_id = ? AND status = ?')
    .all(sessionId, 'pending') as PendingApproval[];
}

export function updatePendingApprovalPlatformMessageId(approvalId: string, platformMessageId: string): void {
  getDb()
    .prepare('UPDATE pending_approvals SET platform_message_id = ? WHERE approval_id = ?')
    .run(platformMessageId, approvalId);
}

export function deletePendingApprovalsBySessionAction(sessionId: string, action: string): number {
  const result = getDb()
    .prepare('DELETE FROM pending_approvals WHERE session_id = ? AND action = ?')
    .run(sessionId, action);
  return result.changes;
}
```

### 5. Append the modules-barrel line (`src/modules/index.ts`)

```typescript
import './pr-factory/index.js';
```

### 6. Container MCP tools

```bash
cp $SKILL/files/container/agent-runner/src/mcp-tools/pr-factory.ts container/agent-runner/src/mcp-tools/pr-factory.ts
```

In `container/agent-runner/src/mcp-tools/index.ts`, insert a side-effect import **before** the `startMcpServer` import line:

```typescript
import './pr-factory.js';
```

### 7. Install the host dependency

```bash
pnpm add undici@8.1.0 --save-exact
```

(`handler.ts` needs undici's own `fetch` + `ProxyAgent` — Node's built-in fetch rejects an external dispatcher. Keep the pin exact.)

### 8. Copy the guard tests

```bash
cp $SKILL/files/src/modules/pr-factory/bootstrap.test.ts src/modules/pr-factory/bootstrap.test.ts
cp $SKILL/files/src/modules/pr-factory/webhook.test.ts src/modules/pr-factory/webhook.test.ts
cp $SKILL/files/src/modules/pr-factory/registration.test.ts src/modules/pr-factory/registration.test.ts
cp $SKILL/files/src/modules/pr-factory/handler.test.ts src/modules/pr-factory/handler.test.ts
cp $SKILL/files/src/modules/pr-factory/orchestrator.test.ts src/modules/pr-factory/orchestrator.test.ts
cp $SKILL/files/src/modules/approvals/response-handler-reject.test.ts src/modules/approvals/response-handler-reject.test.ts
cp $SKILL/files/src/db/pr-threads.test.ts src/db/pr-threads.test.ts
cp $SKILL/files/src/db/sessions-approval-helpers.test.ts src/db/sessions-approval-helpers.test.ts
cp $SKILL/files/container/agent-runner/src/mcp-tools/pr-factory-registration.test.ts container/agent-runner/src/mcp-tools/pr-factory-registration.test.ts
cp $SKILL/files/container/agent-runner/src/mcp-tools/pr-factory-tools.test.ts container/agent-runner/src/mcp-tools/pr-factory-tools.test.ts
```

| Test | Guards |
|------|--------|
| `src/modules/pr-factory/registration.test.ts` | The modules-barrel line via the REAL barrel, the four `pr_*` delivery actions + three core approval handlers (read-side registries), the `GITHUB_WEBHOOK_SECRET` env gate, the host-side `PR_FACTORY_DEFAULT_REPO` contract, and the gh-action seam's not-installed fallback |
| `src/modules/pr-factory/bootstrap.test.ts` | Bootstrap's consumption of the entity-model writers on the real migrated schema: instance-keyed messaging groups (worker default, supervisor/tester named), wiring modes, instruction seeding, idempotence, foreign-wiring drop, drift self-correction |
| `src/modules/pr-factory/webhook.test.ts` | `registerGitHubWebhook`'s mount on core's raw webhook registry over real HTTP: HMAC accept/reject, event filtering, 405, throwing-handler → 500 |
| `src/modules/pr-factory/handler.test.ts` | handler's consumption of resolveSession / writeSessionMessage / pr_threads on real session DBs: the PR_CONTEXT trigger contract, the default triage directive, synchronize kill/re-create, draft deferral, redelivery no-op |
| `src/modules/pr-factory/orchestrator.test.ts` | The two-DB seam: writeOutboundDirect into worker outbound.db, tester-instance session resolution + inbound trigger + wake, PASS/FAIL verdict branching |
| `src/modules/approvals/response-handler-reject.test.ts` | The module's `registerApprovalResolvedHandler` registration through the REAL response handler (with a role-seeded clicking admin — pins the authorization requirement too) |
| `src/db/pr-threads.test.ts` | Migration barrel presence (real `runMigrations`), v2 schema shape (no bot column), the legacy-upgrade recreate arm, idempotence, CRUD |
| `src/db/sessions-approval-helpers.test.ts` | The four appended sessions.ts helpers |
| `container/.../pr-factory-registration.test.ts` | The container mcp-tools barrel line (AST: side-effect import before `startMcpServer()`) |
| `container/.../pr-factory-tools.test.ts` | The four tools' messages_out contract: exact `pr_*` action strings (paired with the host registrations), odd-seq, repo-omission, command normalization |

## Configuration

### Environment (`.env`)

```bash
GITHUB_WEBHOOK_SECRET=<webhook secret>            # required — module is inert without it
PR_FACTORY_SLACK_CHANNEL_ID=C0XXXXXXX             # bare Slack channel id for PR threads
PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID=C0YYYYYYY  # optional — enables the supervisor
PR_FACTORY_DEFAULT_REPO=acme/widgets              # repo assumed when MCP calls omit `repo`
PR_FACTORY_REPO_MIRROR_DIR=data/repo-mirror       # optional — local clone refreshed before each triage
PR_FACTORY_REVIEW_SKILL=                          # optional — see "Review workflow" below
```

`SLACK_BOT_TOKEN` is reused from `/add-slack`; the supervisor's credentials come from the `slack-bots` component.

If `NANOCLAW_EGRESS_LOCKDOWN` is enabled (default off), worker containers cannot reach GitHub and tester containers cannot reach test VMs — leave it off for PR Factory groups or allowlist those hosts.

### GitHub webhook

In the repository (or org) settings, add a webhook: Payload URL `https://your-domain/webhook/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events: **Pull requests** only.

### Grant approver roles (required)

Core's approval-click authorization (`isAuthorizedApprovalClick`) silently ignores card clicks from users without a `user_roles` row — the symptom is a card that does nothing, with only a host-log warning. Grant every human who will click PR Factory approval cards an owner/admin role, e.g.:

```bash
pnpm run ncl roles grant --user 'slack:U0XXXXXXX' --role admin
```

(or the equivalent `grantRole` call from `src/modules/permissions/db/user-roles.ts`). User ids are namespaced `<channel>:<handle>`; the user must already exist in the `users` table (they do after their first message on the channel).

### Review workflow (operator override point)

The worker's triage/review/test-plan workflow ships as **default group instructions**, seeded once into `groups/pr-factory-worker/CLAUDE.local.md` on first bootstrap and never overwritten — edit that file to tune trusted contributors, merge policy, and review depth for your repo. Operators who maintain their own container skill instead set `PR_FACTORY_REVIEW_SKILL=<skill-name>` (and add that skill to the worker group's container config): every PR trigger then opens with `Use the /<skill-name> skill …` and the seeded defaults are ignored.

### Tester agent group (optional)

Create an agent group with folder `pr-tester` (its instructions describe YOUR test environment, so they don't ship here). On the next bootstrap run the module wires it to the PR channel under the `slack-tester` instance. Test execution additionally requires the `vm-test-orchestrator` component.

## Finish

Rebuild the agent image so containers pick up the MCP tools, then restart the host:

```bash
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

## Known smells (declared)

- **Host-side Slack calls outside the adapter.** `handler.ts` (thread opener) and `reactions.ts` call the Slack web API directly with `SLACK_BOT_TOKEN` instead of going through the channel adapter — the opener must return a `ts` synchronously to key the thread, which the adapter's deliver path doesn't expose. Lives entirely in skill-owned files.
- **GitHub credentials.** Host-side GitHub reads ride the OneCLI gateway (vault PAT injected per request — the sanctioned path) with a documented unauthenticated fallback. The `gh-action-approval` component's command execution threads gh tokens via process env from `~/.config/gh/hosts.yml` — declared in that component, with OneCLI as the stated direction.
- **Single-slot seams.** `canvas.ts` / `test-orchestration.ts` / `gh-action.ts` hold one provider each — a second registrant clobbers the first. Acceptable while exactly one component implements each; revisit if that changes.

## Validate

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test; cd ../..
```

All suites green. Any failure means a step didn't apply cleanly.
