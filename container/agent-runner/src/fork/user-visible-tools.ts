/**
 * Fork: user-visible MCP tool tracking (double-delivery suppression).
 *
 * When the agent replies through a user-visible MCP tool (e.g.
 * `mcp__nanoclaw__band_send_message`), the content has already reached the
 * channel; the SDK's final `result` text is then a terse tool summary
 * ("Sent.") that must not be re-delivered by the poll loop's fallback
 * dispatch path.
 *
 * - The registry seeds `mcp__nanoclaw__send_message`; channels add their own
 *   names via the NANOCLAW_USER_VISIBLE_TOOLS env var (JSON array) injected by
 *   the host's buildContainerArgs, read once when this module loads.
 * - The Claude provider yields a `user_visible_tool` event for each matching
 *   `tool_use` part of an assistant message (`userVisibleToolEvents`).
 * - The poll loop owns one `UserVisibleToolTurn` per query: it records those
 *   events and, at each result, decides whether the result text is suppressed.
 */
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderEvent } from '../providers/types.js';

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

const userVisibleTools = new Set<string>(['mcp__nanoclaw__send_message']);

export function markUserVisibleTool(name: string): void {
  userVisibleTools.add(name);
}

export function isUserVisibleToolName(name: string): boolean {
  return userVisibleTools.has(name);
}

/** Seed from a JSON array of tool names. Malformed JSON is logged and ignored; non-string entries are skipped. */
export function seedUserVisibleTools(raw: string | undefined): void {
  if (!raw) return;
  try {
    const names = JSON.parse(raw) as unknown[];
    for (const name of names) {
      if (typeof name === 'string') markUserVisibleTool(name);
    }
  } catch (err) {
    log(`Ignoring malformed NANOCLAW_USER_VISIBLE_TOOLS: ${err instanceof Error ? err.message : String(err)}`);
  }
}

seedUserVisibleTools(process.env.NANOCLAW_USER_VISIBLE_TOOLS);

/** One `user_visible_tool` event per registered tool name used in an SDK assistant message. */
export function* userVisibleToolEvents(message: SDKAssistantMessage): Generator<ProviderEvent> {
  for (const block of message.message.content) {
    if (block.type === 'tool_use' && isUserVisibleToolName(block.name)) {
      yield { type: 'user_visible_tool', name: block.name };
    }
  }
}

/** Per-query turn state for the poll loop. */
export class UserVisibleToolTurn {
  private used = false;

  /** Record a `user_visible_tool` event; ignores every other event type. */
  observe(event: ProviderEvent): void {
    if (event.type !== 'user_visible_tool') return;
    log(`User-visible tool: ${event.name}`);
    this.used = true;
  }

  /**
   * Call exactly once per `result` event. True when a user-visible tool already
   * delivered this turn and the (non-error, non-empty) result text must not be
   * dispatched; the text is logged instead. Always resets for the next turn.
   */
  suppressesResult(resultText: string, failed: boolean): boolean {
    const used = this.used;
    this.used = false;
    if (!used || !resultText || failed) return false;
    log(`[tool-result] ${resultText.slice(0, 200)}`);
    return true;
  }
}
