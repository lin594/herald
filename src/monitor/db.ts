import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// tsup/esbuild (0.2x, via tsup 8.5) rewrites the static `import "node:sqlite"`
// specifier to bare "sqlite"; the require route survives bundling intact.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

const SCHEMA_VERSION = "1";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL DEFAULT 'codex',
    hostname TEXT,
    project TEXT,
    workspace TEXT,
    transcript_path TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    started_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    last_activity_ms INTEGER NOT NULL,
    turn_started_ms INTEGER,
    last_turn_ms INTEGER,
    last_heartbeat_ms INTEGER,
    last_stage TEXT,
    last_message TEXT,
    changed_files INTEGER NOT NULL DEFAULT 0,
    insertions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    last_artifacts TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at_ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS dedup_state (
    session_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    notified_at_ms INTEGER NOT NULL,
    PRIMARY KEY (session_key, kind)
  );
  CREATE TABLE IF NOT EXISTS host_state (
    hostname TEXT PRIMARY KEY,
    last_heartbeat_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'HOST_AVAILABLE',
    bridge_version TEXT,
    updated_at_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS cooldown_state (
    key TEXT PRIMARY KEY,
    last_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turn_state (
    key TEXT PRIMARY KEY,
    started_at_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase(dbPath: string): DatabaseSyncType {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) {
    db.exec("BEGIN");
    try {
      for (const sql of MIGRATIONS) db.exec(sql);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        SCHEMA_VERSION,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    // Volumes written before a column existed keep their rows; `CREATE TABLE
    // IF NOT EXISTS` alone would leave them without it.
    const columns = new Set(
      (
        db
          .prepare("SELECT name FROM pragma_table_info('sessions')")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    if (!columns.has("last_turn_ms")) {
      db.exec("ALTER TABLE sessions ADD COLUMN last_turn_ms INTEGER");
    }
  }
  return db;
}
