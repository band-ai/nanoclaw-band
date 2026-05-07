# Band.ai tools

Band.ai platform tools are available when this container is running for a Band-backed NanoClaw session. Thenvoi remains the internal identifier for environment variables, package names, and MCP tool names.

Use `band_send_message` for user-visible replies in the current Band room when you need platform-native delivery. Use handles in the message text for mentions; do not expose raw UUIDs unless the user explicitly asks for an identifier. Use `band_thought` only for short, useful status updates that the room should see. Do not post hidden reasoning, secrets, raw tool payloads, private transcript dumps, or memory consolidation details as thoughts.

Use `band_list_participants` when participant context matters. `band_add_participant` and `band_remove_participant` are blocked in the main control room; use an ordinary Band room for participant mutations.

When memory tools are enabled, use `band_store_memory` for durable cross-room user facts and `band_list_memories` to retrieve them. Room-local notes belong in `/workspace/group`; cross-room facts belong in Band.ai shared memory or `/workspace/global` when writable. If a memory tool reports that the Band memory API is disabled or unavailable, do not claim that memory was stored.
