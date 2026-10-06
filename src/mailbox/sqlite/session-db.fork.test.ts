import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, insertMessage } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-fork-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function nowForTest(): string {
  return new Date().toISOString();
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('insertMessage', () => {
  it('treats exact replay of the same inbound row as idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');

    const db = new Database(DB_PATH);
    const message = {
      id: 'platform-msg:agent-1',
      kind: 'chat' as const,
      timestamp: nowForTest(),
      platformId: 'band:room-1',
      channelType: 'band',
      threadId: null,
      content: JSON.stringify({ text: 'hello' }),
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
    };

    insertMessage(db, message);
    insertMessage(db, message);

    const rows = db.prepare('SELECT id FROM messages_in').all();
    expect(rows).toHaveLength(1);
    db.close();
  });

  it('rejects replay with conflicting content for the same inbound row id', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');

    const db = new Database(DB_PATH);
    const base = {
      id: 'platform-msg:agent-1',
      kind: 'chat' as const,
      timestamp: nowForTest(),
      platformId: 'band:room-1',
      channelType: 'band',
      threadId: null,
      content: JSON.stringify({ text: 'hello' }),
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
    };

    insertMessage(db, base);
    expect(() => insertMessage(db, { ...base, content: JSON.stringify({ text: 'changed' }) })).toThrow(
      'Conflicting messages_in row',
    );
    db.close();
  });
});
