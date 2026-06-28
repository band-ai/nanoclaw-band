# Band configuration reference

Deep configuration for memory and contact-event handling, plus the optional
outbound-origination Band MCP. All default to off — the base `/add-band` install
does not need any of this.

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
Create the vault secret accordingly, reading the key from `.env` (never paste it):

```bash
KEY=$(grep -E '^(BAND|THENVOI)_(AGENT_)?API_KEY=' .env | head -1 | cut -d= -f2-)
onecli secrets create --name Band --type generic --value "$KEY" \
  --host-pattern app.band.ai --header-name X-API-Key --value-format '{value}'
```

The agent's OneCLI `secretMode` must be `all` (or assign this secret explicitly).
No raw key enters the container: the MCP sends the stub `onecli-managed`, and the
gateway replaces `X-API-Key` on egress to `app.band.ai`. band-mcp uses `httpx`,
which honors the gateway's `SSL_CERT_FILE` and `HTTPS_PROXY` automatically.

### 3. Wire into the global agent group's `container.json`

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
approval, restarts the group) rather than hand-editing `container.json`.

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
