import type { DatabaseSync } from "node:sqlite";
import { MAX_BUNDLE_BYTES } from "@genui/format";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createApi } from "./api.js";
import { enableHosting } from "./hosted.js";
import { Store } from "./store.js";

export { openDatabase } from "./db.js";
export { Store, RegistryError, type Scope } from "./store.js";

export interface RegistryAppOptions {
  /** Let recipe validation webhooks use http and private addresses. For self-hosted installs and tests. */
  allowPrivateWebhooks?: boolean;
}

export function createRegistryApp(db: DatabaseSync, options: RegistryAppOptions = {}): { app: Hono; store: Store } {
  const store = new Store(db);
  const app = new Hono();
  app.use(bodyLimit({ maxSize: MAX_BUNDLE_BYTES * 2 }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/v1", createApi(store, options));
  enableHosting(app, store, options);
  return { app, store };
}
