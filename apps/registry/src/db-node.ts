import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Database } from "./db.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

function transaction<T>(sqlite: DatabaseSync, fn: () => T): T {
  sqlite.exec("BEGIN");
  try {
    const result = fn();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Applies the migration files the database hasn't had yet: the same files and the same d1_migrations
 * table as `wrangler d1 migrations apply`, so both runtimes share one schema history.
 */
function migrate(sqlite: DatabaseSync): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  const applied = new Set((sqlite.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    if (applied.has(name)) continue;
    transaction(sqlite, () => {
      sqlite.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
      sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    });
  }
}

/** Opens (or creates) a SQLite file, `:memory:` for tests, and brings its schema up to date. */
export function openDatabase(path: string): Database {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(sqlite);
  const prepare = (sql: string) => sqlite.prepare(sql);
  const values = (params: unknown[]) => params as SQLInputValue[];
  return {
    auth: sqlite,
    async get<T>(sql: string, ...params: unknown[]) {
      return prepare(sql).get(...values(params)) as T | undefined;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return prepare(sql).all(...values(params)) as T[];
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: Number(prepare(sql).run(...values(params)).changes) };
    },
    async batch(statements) {
      return transaction(sqlite, () => statements.map((s) => prepare(s.sql).all(...values(s.params))));
    },
  };
}
