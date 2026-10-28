import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. The profiles themselves are in
// Pyroscope; this file keeps what people set up and the record of each capture (ADR 0011, 0068).
const MIGRATIONS = [
  `-- A pull target: a service's pprof address (Go's net/http/pprof, or anything that serves the same paths) that
   -- Profiling reads on a schedule or on demand, the profile types it reads there, the labels added to them and how it
   -- signs in. The password or bearer token is sealed with the install's key (ADR 0021) and never returned.
   CREATE TABLE targets (
     id TEXT PRIMARY KEY,
     service TEXT NOT NULL UNIQUE,
     url TEXT NOT NULL,
     types TEXT NOT NULL,
     interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds BETWEEN 15 AND 86400),
     cpu_seconds INTEGER NOT NULL CHECK (cpu_seconds BETWEEN 1 AND 60),
     labels TEXT NOT NULL DEFAULT '{}',
     auth TEXT NOT NULL CHECK (auth IN ('none', 'bearer', 'basic')),
     username TEXT,
     secret TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- One profile read from a target: when, which type, whether it was stored and why not. Kept for the retention.
   CREATE TABLE captures (
     id TEXT PRIMARY KEY,
     target_id TEXT,
     service TEXT NOT NULL,
     type TEXT NOT NULL,
     trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
     status TEXT NOT NULL CHECK (status IN ('capturing', 'stored', 'failed')),
     error TEXT,
     bytes INTEGER,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     created_by TEXT NOT NULL
   );
   CREATE INDEX captures_started ON captures (started_at);
   CREATE INDEX captures_target ON captures (target_id, started_at)`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
