/**
 * SQLite database layer for agent-observability-mcp.
 * DB lives at ~/.agent-observability-mcp/obs.db
 * WAL mode enabled; indexes on session_id for all tables.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.agent-observability-mcp');
const DB_PATH = join(DB_DIR, 'obs.db');

if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL,
    last_activity TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS traces (
    trace_id   TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp  TEXT NOT NULL,
    data_json  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_traces_session ON traces (session_id);

  CREATE TABLE IF NOT EXISTS token_calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    model         TEXT NOT NULL,
    provider      TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost          REAL NOT NULL,
    timestamp     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_token_calls_session ON token_calls (session_id);

  CREATE TABLE IF NOT EXISTS tool_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    server_name TEXT NOT NULL,
    tool_name   TEXT NOT NULL,
    params_json TEXT,
    result_summary TEXT,
    latency_ms  REAL NOT NULL,
    success     INTEGER NOT NULL,
    error       TEXT,
    timestamp   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_id);
`);

// ─── Prepared statements ───────────────────────────────────────────────────────

export const stmts = {
  // sessions
  getSession: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
  insertSession: db.prepare(
    'INSERT INTO sessions (session_id, created_at, last_activity) VALUES (?, ?, ?)'
  ),
  updateLastActivity: db.prepare(
    'UPDATE sessions SET last_activity = ? WHERE session_id = ?'
  ),
  listSessions: db.prepare('SELECT session_id FROM sessions'),

  // traces
  insertTrace: db.prepare(
    'INSERT INTO traces (trace_id, session_id, timestamp, data_json) VALUES (?, ?, ?, ?)'
  ),
  getTracesBySession: db.prepare(
    'SELECT * FROM traces WHERE session_id = ? ORDER BY timestamp ASC'
  ),

  // token_calls
  insertTokenCall: db.prepare(
    'INSERT INTO token_calls (session_id, model, provider, input_tokens, output_tokens, cost, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  getTokenCallsBySession: db.prepare(
    'SELECT * FROM token_calls WHERE session_id = ? ORDER BY timestamp ASC'
  ),
  getTokenCallsBySessionIds: db.prepare(
    // Used dynamically — see getCostReport
    'SELECT * FROM token_calls ORDER BY timestamp ASC'
  ),

  // tool_calls
  insertToolCall: db.prepare(
    'INSERT INTO tool_calls (session_id, server_name, tool_name, params_json, result_summary, latency_ms, success, error, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  getToolCallsBySession: db.prepare(
    'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC'
  ),
};

export default db;
