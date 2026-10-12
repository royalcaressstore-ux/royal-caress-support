import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ensureDataDir } from './config.js';

let db;

export function openDb(file) {
  if (file !== ':memory:') ensureDataDir();
  db = new DatabaseSync(file || path.join(config.dataDir, 'support.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,                 -- 'web' | 'whatsapp'
      external_id TEXT,                      -- telefone (whatsapp) ou id de visitante (web)
      customer_name TEXT,
      customer_email TEXT,
      status TEXT NOT NULL DEFAULT 'ai',     -- 'ai' | 'needs_human' | 'human' | 'resolved'
      assigned_to TEXT,
      flag_reason TEXT,
      verified_order TEXT,                   -- número do pedido verificado (e-mail conferido)
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_customer_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_ext ON conversations(channel, external_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,                    -- 'customer' | 'ai' | 'staff' | 'system'
      author TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL,                    -- 'cancel_order' | 'refund_order' | 'update_address'
      order_name TEXT NOT NULL,
      payload TEXT NOT NULL,                 -- JSON
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'approved' | 'rejected' | 'failed'
      decided_by TEXT,
      decided_at INTEGER,
      result TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,                    -- 'ai_reply' | 'escalated' | 'blocked_injection' | 'rate_limited' ...
      conversation_id TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, created_at);

    CREATE TABLE IF NOT EXISTS ratings (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      stars INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export const now = () => Date.now();
export const newId = () => crypto.randomBytes(12).toString('hex');
export const getDb = () => db;

export function logEvent(kind, conversationId, detail) {
  db.prepare('INSERT INTO events (kind, conversation_id, detail, created_at) VALUES (?,?,?,?)')
    .run(kind, conversationId || null, detail ? String(detail).slice(0, 500) : null, now());
}
