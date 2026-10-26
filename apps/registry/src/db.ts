/** A SQL statement with its parameters, for `Database.batch`. */
export interface Statement {
  sql: string;
  params: unknown[];
}

export const statement = (sql: string, ...params: unknown[]): Statement => ({ sql, params });

/**
 * The registry's database: SQLite through node:sqlite (Docker, local development) or Cloudflare D1.
 * Async because D1 is. D1 has no interactive transactions, so writes that belong together go in one
 * `batch`, which is atomic on both. The schema lives in `migrations/`, applied by `wrangler d1
 * migrations apply` on Cloudflare and by `openDatabase` on Node.
 */
export interface Database {
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** Runs a write; `changes` is the number of rows it changed. */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Runs the statements in one transaction and returns each one's rows (from RETURNING). */
  batch(statements: Statement[]): Promise<unknown[][]>;
  /** What better-auth is given: node:sqlite's DatabaseSync or the D1 binding. */
  readonly auth: object;
}
