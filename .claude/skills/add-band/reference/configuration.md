# Band configuration reference

Deep configuration for memory and contact-event handling, plus the optional
outbound-origination Band MCP. All default to off — the base `/add-band` install
does not need any of this.

## Connection settings

Before registration, vault creation/rotation, or optional MCP configuration,
resolve the existing connection base without asking deployment questions. Use the
first nonempty value in runtime order: process `BAND_BASE_URL`, process
`THENVOI_BASE_URL`, `.env` `BAND_BASE_URL`, `.env` `THENVOI_BASE_URL`, then
`https://app.band.ai`. Read only those settings as data, without sourcing `.env`
or printing credentials. If the selected value comes from `.env`, export it as
`BAND_BASE_URL` for the commands below. After authentication recovery, use the
confirmed replacement value and remove stale overrides instead.

Run this in the same shell as registration and the vault commands:

```bash
export BAND_BASE_URL="${BAND_BASE_URL:-${THENVOI_BASE_URL:-https://app.band.ai}}"
BAND_HOST=$(node -e 'process.stdout.write(new URL(process.env.BAND_BASE_URL).host)') || exit 1
```

Keep `BAND_BASE_URL` with the agent credentials in `.env` and align the service's
active environment. The registration helper reads the exported base; the vault
commands use `BAND_HOST`; the host and container runtime read the persisted base.
A successful setup uses these existing settings without entering authentication
recovery. The browser site is not an alternative source for API paths.

## Authentication recovery

For a Band 401/403 during setup, follow the [shared recovery guide](https://github.com/band-ai/add-band/blob/main/ONBOARDING-RECOVERY.md)
before retrying. Reuse known context and compare the destination actually used.
If the guide cannot be loaded, ask only missing context: “Band rejected the request.
The key or Band address may be different. What website do you normally open to use
Band?” Explain why the comparison helps. A browser address does not establish API
paths; resolve them from deployment documentation or available configuration.
If details are missing, offer: “I use Band at <website>. Please send connection
details compatible with NanoClaw's Band integration and how to obtain an agent-create
key for that site.” When the destination is confirmed but still rejects, verify
same-site key provenance, permission, and OneCLI host/secret assignment. Do not
infer revocation or a separate deployment from the error alone.

Configure the confirmed `BAND_BASE_URL` for the user in `.env` and the active
registration/service environment. Inspect `THENVOI_BASE_URL` too: process variables
(including legacy ones) override persisted values. Replace or clear stale overrides,
including an explicit cloud value on return to cloud. The runtime preserves HTTP
versus HTTPS, but derives REST origin and `/api/v1/socket` on the same host. Arbitrary
independent REST/WS hosts or prefixes are unsupported; seek compatible administrator
settings rather than inventing variables. Use the known browser site for UI links.

Apply [connection settings](#connection-settings) with the confirmed base before
any vault update. Keep each agent key bound to its existing deployment; if the
destination changes, reconcile the appropriate identity first as described below.

Update the existing Band vault secret's host
pattern and preserve its protections/assignments. The host adapter reads `.env`;
its container contribution derives `BAND_REST_URL`. Update optional MCP settings
below too when installed, through the group's supported config interface.
Restart the host and affected groups, then verify an actual reply in Band.

Preserve successful registrations and their destination. An existing-key gate must
not skip endpoint repairs. If the destination changes, retain/report the old identity
separately and reconcile credentials on the confirmed site before continuing; never
send the old site's key to the new site. After interruption or an uncertain POST,
check the site's existing agents in UI/configuration before creating anything else.
A name conflict requires the same reconciliation. Stop dependent work on cancellation;
do not blindly retry, delete agents, or echo credential-bearing responses.

After a bootstrap failure,
`env -u BAND_USER_API_KEY -u BAND_API_KEY -u BAND_AGENT_API_KEY claude /add-band`
starts this recovery without inherited keys. Obtain any replacement secret
through the existing local hidden prompt, never chat or LLM environment. If no
assistant is available, give the guide and administrator request without retrying.
Once repaired, resume only unfinished steps. LLM-provider failures and ordinary
reply timeouts are separate; neither alone justifies deployment questions.

## Memory knobs

```bash
BAND_MEMORY_TOOLS=false
BAND_MEMORY_LOAD_ON_START=false
BAND_MEMORY_CONSOLIDATION=false
```

- **`BAND_MEMORY_TOOLS`** — exposes `mcp__nanoclaw__band_list_memories`,
  `band_store_memory`, `band_supersede_memory`, etc. to the agent. The other two
  memory knobs are no-ops without this enabled.
- **`BAND_MEMORY_LOAD_ON_START`** — at container startup, fetch each room
  participant's stored memories via the SDK (`thenvoi_list_memories`,
  scope=`subject`, top 10 per participant) and append them to the system prompt
  under `## Existing Memories About Room Participants`. Also injects a synthetic
  `[System]` message when a participant joins mid-session (`participant_added`),
  with up to 10 of that participant's memories. Failure is non-fatal — the agent
  still starts. Registered through the container lifecycle start hook in
  `container/agent-runner/src/band-lifecycle.ts`.
- **`BAND_MEMORY_CONSOLIDATION`** — after the poll loop exits (typically SIGTERM
  from `docker stop` when the host kills the container), run a one-shot
  consolidation pass against the same provider session. The pass cannot send chat
  messages or `<message to="…">` blocks; only memory tools are available, and
  output is drained, not delivered. No-op unless `BAND_MEMORY_TOOLS` is enabled.
  Registered through the container lifecycle stop hook.

## Contact strategies

```bash
BAND_CONTACT_STRATEGY=disabled        # disabled | hub_room
BAND_CONTACT_AGENT_GROUP_ID=          # optional; group to handle hub messages
```

Controls what the host does with `contact_request_received`,
`contact_request_updated`, `contact_added`, and `contact_removed` events:

- **`disabled`** (default) — events are dropped silently. The agent never sees
  contacts; outbound contact tools still work.
- **`hub_room`** — lazily provision a per-agent "Contact Hub" Band room, add
  `BAND_OWNER_ID` (or the value from `GET /agent/me`) as a member, persist its
  room id in `data/v2.db` module state (`module_state`, created by the
  `module-band-state` channel migration), wire it to `BAND_CONTACT_AGENT_GROUP_ID`
  (or the only agent group when exactly one exists), and forward every contact
  event into the hub as a synthetic message. The owner replies in the hub.

## Outbound origination: Band MCP (global agent only)

The native `band_*` tools shipped by the channel are **room-scoped**: they only
register inside a Band-room session (`BAND_ROOM_ID` set), and
`band_create_chatroom` / `band_add_participant` are blocked in the main control
room. They let an agent act *within* a room it already serves.

To let your **global** assistant — the DM agent that fields
Telegram/WhatsApp/Slack — *originate* Band activity ("create a Band chat with X
and post Y there"), wire the standalone Band MCP server: `band-mcp` (PyPI; binary
`thenvoi-mcp`; repo github.com/thenvoi/thenvoi-mcp). It is identity-scoped (agent
key), not room-scoped, so it exposes `create_agent_chat`,
`add_agent_chat_participant`, `create_agent_chat_message`, `list_agent_chats`, etc.

> This is an **optional, manual** add-on. The base `/add-band` install touches no
> Dockerfile and ships no `INSTALL_BAND_MCP` build gate — the steps below are
> edits you make yourself if you want outbound origination.

> **Rule: wire it only into the global / non-room agent group. Never add it to an
> agent group bound to a Band messaging group.** A Band-room agent already speaks to
> its room through the channel; giving it chat-creation tools invites delivery loops
> and lets a room agent spawn unrelated chats. Because the MCP lives in one agent
> group's `container.json`, scoping is automatic — just don't copy it into room groups.

### 1. Install in the image (shared, pinned)

band-mcp is a Python package; isolate it in a venv. In `container/Dockerfile` add
`python3` + `python3-venv` to the apt block and, after the Node CLIs:

```dockerfile
ARG BAND_MCP_VERSION=1.3.1
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m venv /opt/band-mcp && \
    /opt/band-mcp/bin/pip install "band-mcp==${BAND_MCP_VERSION}" && \
    ln -sf /opt/band-mcp/bin/thenvoi-mcp /usr/local/bin/thenvoi-mcp
```

Rebuild: `./container/build.sh`. (pip is not gated by the pnpm `minimumReleaseAge`
policy — check the PyPI release date and pin deliberately when bumping.)

### 2. Credential: OneCLI gateway, `X-API-Key` (not Bearer)

Band's API authenticates with the **`X-API-Key`** header. `Authorization: Bearer
<key>` returns `401 "Invalid JWT token"` — the README's curl example is misleading.
Create the vault secret accordingly, reading the key from `.env` (never paste it).
Apply [connection settings](#connection-settings) before the vault command,
using existing configuration without extra questions on successful setup:

```bash
KEY=$(grep -E '^(BAND|THENVOI)_(AGENT_)?API_KEY=' .env | head -1 | cut -d= -f2-)
onecli secrets create --name Band --type generic --value "$KEY" \
  --host-pattern "$BAND_HOST" --header-name X-API-Key --value-format '{value}'
```

The agent's OneCLI `secretMode` must be `all` (or assign this secret explicitly).
No raw key enters the container: the MCP sends the stub `onecli-managed`, and the
gateway replaces `X-API-Key` on egress to the confirmed host. band-mcp uses `httpx`,
which honors the gateway's `SSL_CERT_FILE` and `HTTPS_PROXY` automatically.

### 3. Wire into the global agent group's configuration

The JSON below illustrates cloud defaults. Set both base URL entries to the
confirmed connection URL, preserving the stub credentials. Use `ncl groups config`
or the supported self-mod flow; `container.json` is materialized from group config
at spawn, so editing only that generated file does not persist the repair.

```jsonc
"mcpServers": {
  "band": {
    "command": "thenvoi-mcp",
    "args": ["--scope", "agent", "--tools", "contacts"],
    "env": {
      "BAND_AGENT_KEY": "onecli-managed",
      "THENVOI_AGENT_KEY": "onecli-managed",
      "BAND_BASE_URL": "https://app.band.ai",
      "THENVOI_BASE_URL": "https://app.band.ai"
    }
  }
}
```

Cleaner still: add it via the `add_mcp_server` self-mod flow (single admin
approval, restarts the group) through the supported group configuration.

Tools surface as `mcp__band__*` and are auto-allowlisted (the runner maps each
configured MCP server name to an allow pattern) — no `claude.ts` edit needed.
Restart the host or wait for the next session spawn to pick up the new image + config.

### Verify

```bash
# binary present + starts (offline)
docker run --rm --entrypoint thenvoi-mcp <agent-image> --help
```

Then ask the global agent (e.g. over Telegram): *"what's my Band agent identity?"* —
it should call `mcp__band__get_agent_me` and return the agent handle.

🛰️
