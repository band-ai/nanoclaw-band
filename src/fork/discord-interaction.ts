/**
 * Fork-owned: Discord interaction callback URL for the chat-sdk bridge's
 * UPDATE_MESSAGE acknowledgement, with the interaction id and token
 * path-encoded so a malformed value cannot escape its path segment.
 */
export function discordInteractionCallbackUrl(interactionId: string, interactionToken: string): string {
  return `https://discord.com/api/v10/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`;
}
