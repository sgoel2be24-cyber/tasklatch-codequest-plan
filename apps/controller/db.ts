import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUNTIME_DIR } from '../../packages/contracts/runtime.ts';

const DB_FILE = process.env.TASKLATCH_DB || path.join(RUNTIME_DIR, 'tasklatch.sqlite');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
export const DB_PATH = DB_FILE;

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bootstrap_codes (
  code_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id), title TEXT NOT NULL,
  request TEXT NOT NULL, scope TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1, recording INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, started_at TEXT, deadline_at TEXT, ended_at TEXT,
  stop_requested_at TEXT, stop_confirmed_at TEXT, interrupted_at TEXT, status_reason TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, assignee TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, source_ids TEXT, updated_at TEXT NOT NULL, ord INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  session_id TEXT NOT NULL REFERENCES sessions(id), worker_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
  activity TEXT, current_url TEXT, last_screenshot TEXT, credential_hash TEXT, lease_expires_at TEXT,
  steps_used INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, stopped_at TEXT,
  PRIMARY KEY (session_id, worker_id)
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), actor TEXT NOT NULL, task_id TEXT,
  action_type TEXT NOT NULL, resource TEXT, payload TEXT, decision TEXT NOT NULL, reason_code TEXT NOT NULL,
  reason TEXT NOT NULL, policy_version INTEGER NOT NULL, created_at TEXT NOT NULL, outcome TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), action_id TEXT NOT NULL,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, policy_version INTEGER NOT NULL, resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  decided_at TEXT, decided_by TEXT, note TEXT, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), approval_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, request_id TEXT, receipt_id TEXT, detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), actor TEXT NOT NULL, kind TEXT NOT NULL,
  purpose TEXT NOT NULL, calls INTEGER NOT NULL, tokens_reserved INTEGER NOT NULL, status TEXT NOT NULL,
  tokens_used INTEGER, usage_source TEXT, retry_of TEXT, created_at TEXT NOT NULL, settled_at TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner TEXT NOT NULL, kind TEXT NOT NULL,
  label TEXT NOT NULL, rel_path TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), deliverable TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT NOT NULL, checks TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
  provenance TEXT NOT NULL, summary TEXT NOT NULL, data TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_res_session ON reservations(session_id);
`);

/** Run fn inside a write transaction. node:sqlite is synchronous, so this is atomic per process. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
export const get = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
