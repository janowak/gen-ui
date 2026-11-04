import { readdirSync, readFileSync } from "node:fs";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll } from "vitest";
import { d1Database, type D1Binding } from "./db-d1.js";
import type { Database } from "./db.js";
import { openDatabase } from "./db-node.js";

export { loadAssets } from "./assets-node.js";

/** Tests run on node:sqlite, or on a local D1 (Miniflare) with APP_MCP_TEST_DB=d1. `pnpm test` runs both. */
export const onD1 = process.env.APP_MCP_TEST_DB === "d1";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

/** The migration files as single statements, the way D1's prepare takes them. */
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .flatMap((file) =>
      readFileSync(new URL(file, MIGRATIONS), "utf8")
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean),
    );
}

/** A new, empty database with the current schema. */
export async function testDatabase(): Promise<Database> {
  if (!onD1) return openDatabase(":memory:");
  const miniflare = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }));
  afterAll(() => miniflare.dispose());
  const d1 = (await miniflare.getD1Database("DB")) as unknown as D1Binding;
  await d1.batch(migrationStatements().map((sql) => d1.prepare(sql)));
  return d1Database(d1);
}
