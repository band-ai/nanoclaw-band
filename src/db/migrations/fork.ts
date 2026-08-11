/**
 * Fork-owned migration registration.
 *
 * Migrations the fork adds to the *host* central DB are registered here instead
 * of being spliced into the upstream core `migrations` array in index.ts. That
 * array is a shared seam: every upstream release that adds a migration edits the
 * same import block + array lines, so a fork entry there conflicts on every
 * sync (this is exactly what broke the upstream-sync job). Registering through
 * the channel-migration registry keeps fork migrations in fork-owned files that
 * upstream never touches — no renumbering, no barrel edits, no conflicts.
 *
 * Convention for future fork migrations:
 *   - file name: `fork-<slug>.ts` (out of the numbered core sequence)
 *   - `version`: reserved 900+ range (cosmetic ordering hint; uniqueness is by
 *     `name`, so pick any unused number)
 *   - add the migration to `forkMigrations` below — never to index.ts
 *
 * Registered under the reserved 'fork' key. Call registerForkMigrations() once,
 * before runMigrations() (see src/index.ts) and from any test that needs the
 * fork's tables.
 */
import { registerChannelMigrations, type Migration } from './index.js';
import { routeFoundationState } from './fork-route-foundation-state.js';

export const forkMigrations: Migration[] = [routeFoundationState];

export function registerForkMigrations(): void {
  registerChannelMigrations('fork', forkMigrations);
}
