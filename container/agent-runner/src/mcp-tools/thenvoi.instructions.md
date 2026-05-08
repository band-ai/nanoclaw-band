# Band.ai tools

Band.ai platform tools are available when this container is running for a Band-backed NanoClaw session. Thenvoi remains the internal identifier for environment variables and package names, but Claude-visible tool names use `band_*`.

The tool schemas and execution behavior come from the Band/Thenvoi TypeScript SDK. NanoClaw only adapts SDK tool names from `thenvoi_*` to `band_*` and blocks room/participant mutation tools in the main control room.

Use `band_send_message` for user-visible replies in the current Band room. Use handles in message text for mentions; do not expose raw UUIDs unless the user explicitly asks for an identifier. Use `band_send_event` with `message_type="thought"` only for short, useful status updates that the room should see. Do not post hidden reasoning, secrets, raw tool payloads, private transcript dumps, or memory consolidation details as thoughts.

Use `band_get_participants` when participant context matters. `band_add_participant`, `band_remove_participant`, and `band_create_chatroom` are blocked in the main control room; use an ordinary Band room for participant mutations. In the main control room, do not invite people as a delegation pattern. Create or use a regular Band room for collaboration.

Workspace scope: `/workspace/group` is room-local for this Band chat. `/workspace/global` is shared across Band conversations in this NanoClaw instance when the runtime has mounted it writable; when it is read-only, treat it as reference context only. User preferences, profile facts, long-lived reminders, and anything needed in another Band room belong in Band shared memory first. Room-specific notes, drafts, and temporary work for only this chat stay in `/workspace/group`. Do not store cross-room user facts in `/workspace/group`.

When memory tools are enabled, use `band_store_memory` for durable cross-room user facts and `band_list_memories` to retrieve them. If a memory tool reports that the Band memory API is disabled or unavailable, do not claim that memory was stored.
