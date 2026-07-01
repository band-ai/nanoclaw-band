/**
 * scripts/upgrade-state.ts — read, check, or stamp the upgrade marker.
 *
 * Usage:
 *   pnpm exec tsx scripts/upgrade-state.ts get
 *   pnpm exec tsx scripts/upgrade-state.ts check
 *   pnpm exec tsx scripts/upgrade-state.ts set [version] [via]
 *
 * `set` with no version stamps the current package.json version. The
 * sanctioned upgrade paths (setup / update / migrate) call `set` on
 * success; running it by hand is also the documented way to clear the
 * startup tripwire — see docs/upgrade-recovery.md.
 *
 * `check` is the read-only precondition probe: exit 0 and print `current`
 * when the marker matches, exit 1 and print `drift` otherwise. Install
 * skills that rebuild `dist/` (any `/add-*` skill, `/customize`) use it to
 * warn up front that a restart may hit the tripwire, and
 * `scripts/safe-restart.sh` uses it as the single source of truth for the
 * comparison instead of re-deriving it in bash.
 */
import { getCodeVersion, isUpgradeCurrent, markerPath, readUpgradeState, writeUpgradeState } from '../src/upgrade-state.js';

const [, , cmd, versionArg, viaArg] = process.argv;

if (cmd === 'get') {
  const state = readUpgradeState();
  console.log(state ? JSON.stringify(state) : 'none');
} else if (cmd === 'check') {
  const code = getCodeVersion();
  const recorded = readUpgradeState()?.version ?? 'none';
  if (isUpgradeCurrent()) {
    console.log(`current ${code}`);
  } else {
    console.log(`drift code=${code} marker=${recorded}`);
    process.exit(1);
  }
} else if (cmd === 'set') {
  const state = writeUpgradeState({ version: versionArg || getCodeVersion(), via: viaArg || 'manual' });
  console.log(`Stamped ${markerPath()}: ${JSON.stringify(state)}`);
} else {
  console.error('Usage: pnpm exec tsx scripts/upgrade-state.ts get | check | set [version] [via]');
  process.exit(2);
}
