/**
 * `ncl roles grant|revoke` scope with `--group`. `--agent-group-id` (the column
 * name, and the flag other verbs use) used to be silently ignored, turning a
 * scoped admin grant into a global one and a scoped revoke into removing the
 * global role.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { getUserRoles, grantRole } from '../../modules/permissions/db/user-roles.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers `roles-grant` / `roles-revoke`.
import './roles.js';

const USER = 'band:user-1';
const GROUP = 'ag-1';

function run(command: string, args: Record<string, unknown>) {
  return dispatch({ id: 'req', command, args }, { caller: 'host' });
}

describe('roles grant/revoke scoping', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    const created_at = new Date().toISOString();
    await createAgentGroup({ id: GROUP, name: 'one', folder: 'one', agent_provider: null, created_at });
    await createUser({ id: USER, kind: 'band', display_name: null, created_at });
  });

  afterEach(async () => {
    await closeDb();
  });

  it('grant --group scopes the admin role to that agent group', async () => {
    const resp = await run('roles-grant', { user: USER, role: 'admin', group: GROUP });

    expect(resp.ok).toBe(true);
    expect((await getUserRoles(USER)).map((r) => [r.role, r.agent_group_id])).toEqual([['admin', GROUP]]);
  });

  it('grant --agent-group-id is rejected instead of granting global admin', async () => {
    const resp = await run('roles-grant', { user: USER, role: 'admin', 'agent-group-id': GROUP });

    expect(resp.ok).toBe(false);
    expect(resp.ok ? '' : resp.error.message).toMatch(/--group/);
    expect(await getUserRoles(USER)).toEqual([]);
  });

  it('grant accepts --agent-group-id when it matches --group (dispatcher auto-fill)', async () => {
    const resp = await run('roles-grant', { user: USER, role: 'admin', group: GROUP, agent_group_id: GROUP });

    expect(resp.ok).toBe(true);
    expect((await getUserRoles(USER)).map((r) => r.agent_group_id)).toEqual([GROUP]);
  });

  it('revoke --agent-group-id is rejected and leaves the global role in place', async () => {
    await grantRole({ user_id: USER, role: 'admin', agent_group_id: null, granted_by: null, granted_at: '' });

    const resp = await run('roles-revoke', { user: USER, role: 'admin', 'agent-group-id': GROUP });

    expect(resp.ok).toBe(false);
    expect((await getUserRoles(USER)).map((r) => [r.role, r.agent_group_id])).toEqual([['admin', null]]);
  });
});
