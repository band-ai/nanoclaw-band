/**
 * Band.ai end-of-session memory consolidation.
 *
 * When `THENVOI_MEMORY_CONSOLIDATION=true` and the channel is `thenvoi`, this
 * runs once after the poll loop has exited (typically on SIGTERM from the host
 * when the container is being shut down). It drives the configured provider
 * directly with a consolidation prompt — events are drained but never written
 * to outbound.db, since this is internal housekeeping the user must not see.
 *
 * Failure is non-fatal — the container exits regardless.
 */
import type { AgentProvider } from './providers/types.js';

function log(msg: string): void {
  console.error(`[band-memory-consolidate] ${msg}`);
}

function shouldRun(): boolean {
  return process.env.THENVOI_MEMORY_CONSOLIDATION === 'true' && process.env.NANOCLAW_CHANNEL === 'thenvoi';
}

const CONSOLIDATION_PROMPT = `You are now in memory consolidation mode. The conversation has ended.
Your job is to review what happened and manage long-term memories.

Today's date: __TODAY__

## CRITICAL RULES
- Do NOT send any chat messages (no mcp__nanoclaw__band_send_message calls)
- Do NOT emit any <message to="..."> blocks — there is no user listening
- Only use memory tools and thought events (mcp__nanoclaw__band_send_event)

## Memory Systems
- **long_term/semantic**: General facts and preferences ("Prefers dark mode")
- **long_term/episodic**: Specific dated events ("Discussed project deadline on 2026-03-22")
- **long_term/procedural**: Behavioral patterns ("Usually asks follow-up questions about costs")

## Your Tasks
1. **ALWAYS call mcp__nanoclaw__band_list_memories() first** to see what's already stored
2. Compare the conversation that just ended against existing memories
3. **Think out loud**: Before each memory operation, call mcp__nanoclaw__band_send_event(content="your reasoning", message_type="thought")
4. Consolidate memories:
   - Create new memories only for genuinely NEW information (mcp__nanoclaw__band_store_memory)
   - Supersede outdated memories when information has CHANGED (mcp__nanoclaw__band_supersede_memory)
   - Supersede duplicate memories — if you see multiple memories with the same info, keep only one
   - If information already exists (even with different wording) → do NOT create a duplicate
5. Use episodic for specific events (include dates), semantic for general facts/preferences
6. **If no new information**: Report "No new information to store" via thought event and finish

## Rules
- Only store genuinely useful information
- Include dates in episodic memories
- Keep memories concise (under 100 characters when possible)
- Your thought field should explain WHY this memory is useful
- Always add 2-5 lowercase hyphenated tags (e.g., "preferences", "scheduling", "decisions")
- Use segment="user" for info about the user, segment="agent" for self-knowledge
- Do NOT store raw conversation content (the platform already tracks messages)

Report what you stored/superseded via mcp__nanoclaw__band_send_event(content, message_type="thought"), then finish.`;

export async function runMemoryConsolidation(args: {
  provider: AgentProvider;
  providerName: string;
  cwd: string;
  continuation: string | undefined;
}): Promise<void> {
  if (!shouldRun()) return;
  if (!args.continuation) {
    log('Skipped: no continuation — nothing to consolidate');
    return;
  }

  log('Running memory consolidation…');
  const today = new Date().toISOString().split('T')[0];
  const prompt = CONSOLIDATION_PROMPT.replace('__TODAY__', today);

  const query = args.provider.query({
    prompt,
    continuation: args.continuation,
    cwd: args.cwd,
    // No systemContext — the agent's existing system prompt has the destination
    // map and Band tool guidance baked in via CLAUDE.md. We override behavior
    // through the prompt itself ("do NOT send messages, do NOT emit <message>").
  });

  try {
    for await (const event of query.events) {
      if (event.type === 'error') {
        log(`Provider error during consolidation: ${event.message}`);
      } else if (event.type === 'result') {
        log(`Consolidation result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      }
      // Intentionally drain everything else without dispatch — no writes to
      // outbound.db. Tool-side memory writes happen inside the SDK MCP server
      // and persist via Band's REST API regardless of whether we route the
      // result text anywhere.
    }
    log('Consolidation complete');
  } catch (err) {
    log(`Consolidation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
