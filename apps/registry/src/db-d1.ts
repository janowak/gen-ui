import type { Database } from "./db.js";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

/** The parts of Cloudflare's D1 binding the registry uses. */
export interface D1Binding {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ results?: unknown[] }[]>;
}

/** The registry's database on a D1 binding. */
export function d1Database(d1: D1Binding): Database {
  // D1 can't bind undefined.
  const prepare = (sql: string, params: unknown[]) => d1.prepare(sql).bind(...params.map((value) => (value === undefined ? null : value)));
  return {
    auth: d1,
    async get<T>(sql: string, ...params: unknown[]) {
      return (await prepare(sql, params).first<T>()) ?? undefined;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return (await prepare(sql, params).all<T>()).results;
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: (await prepare(sql, params).run()).meta.changes };
    },
    async batch(statements) {
      const results = await d1.batch(statements.map((s) => prepare(s.sql, s.params)));
      return results.map((result) => result.results ?? []);
    },
  };
}
