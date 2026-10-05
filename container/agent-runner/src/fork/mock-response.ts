/**
 * Fork: MockProvider default response. Wraps the canned reply in a
 * `<message to="…">` block addressed to the prompt's first `from="…"` origin,
 * so a mock-provider runner (e.g. a live channel smoke) actually delivers it;
 * a prompt without an origin gets the bare reply.
 */
export function defaultMockResponse(prompt: string): string {
  const fromMatch = prompt.match(/\bfrom="([^"]+)"/);
  const response = `Mock response to: ${prompt.slice(0, 100)}`;
  return fromMatch ? `<message to="${fromMatch[1]}">${response}</message>` : response;
}
