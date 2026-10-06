/**
 * Fork: destination label in the system-prompt destinations section.
 *
 * Display name first, then the kind of destination — "agent", or the
 * capitalized channel type ("Band", "Telegram") — joined with " — ", so the
 * model can map a natural reference ("send it on Band") to the local name.
 */
import type { DestinationEntry } from '../destinations.js';

export function destinationLabel(d: DestinationEntry): string {
  const parts: string[] = [];
  if (d.displayName && d.displayName !== d.name) parts.push(d.displayName);
  if (d.type === 'agent') parts.push('agent');
  else if (d.channelType) parts.push(d.channelType.charAt(0).toUpperCase() + d.channelType.slice(1));
  return parts.length ? ` (${parts.join(' — ')})` : '';
}
