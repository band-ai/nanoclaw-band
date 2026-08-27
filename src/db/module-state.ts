import { getDb } from './connection.js';

export interface ModuleStateRow {
  module_name: string;
  key: string;
  value_json: string;
  updated_at: string;
}

export async function getModuleState<T = unknown>(moduleName: string, key: string): Promise<T | undefined> {
  const row = await getDb().get<{ value_json: string }>(
    'SELECT value_json FROM module_state WHERE module_name = ? AND key = ?',
    moduleName,
    key,
  );
  if (!row) return undefined;
  return JSON.parse(row.value_json) as T;
}

export async function setModuleState(moduleName: string, key: string, value: unknown): Promise<void> {
  await getDb().run(
    `INSERT INTO module_state (module_name, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module_name, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    moduleName,
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
}

export async function deleteModuleState(moduleName: string, key: string): Promise<void> {
  await getDb().run('DELETE FROM module_state WHERE module_name = ? AND key = ?', moduleName, key);
}

export async function listModuleState(moduleName: string): Promise<ModuleStateRow[]> {
  return getDb().all<ModuleStateRow>('SELECT * FROM module_state WHERE module_name = ? ORDER BY key', moduleName);
}
