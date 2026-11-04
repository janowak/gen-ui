import chart from "@app-mcp/ui/views/chart.html";
import form from "@app-mcp/ui/views/form.html";
import manager from "@app-mcp/ui/views/manager.html";
import workflows from "@app-mcp/ui/views/workflows.html";
import theme from "@app-mcp/ui/views/theme.html";
import instructions from "@app-mcp/ui/views/instructions.html";
import workspace from "@app-mcp/ui/views/workspace.html";
import consent from "../dist-web/consent.html";
import signIn from "../dist-web/sign-in.html";
import { createRegistryApp, type Refresher } from "./app.js";
import { authConfigFromEnv, type MetadataFetch } from "./auth.js";
import { d1Database, type D1Binding } from "./db-d1.js";
import { enableManagement } from "./management.js";
import type { Assets } from "./views.js";
import type { ExecutionContext, Hono } from "hono";

// The registry on Cloudflare Workers, with D1 as its database (wrangler.jsonc). main.ts runs it on Node.

interface Env {
  DB: D1Binding;
}

const assets: Assets = {
  views: { form, chart, manager, theme, workflows, workspace, instructions },
  pages: { "sign-in": signIn, consent },
};

/**
 * Client ID Metadata Documents over plain fetch. A Worker has no private network behind it to reach,
 * which is what the Node transport's DNS pinning protects; https only, and redirects are never followed.
 */
const fetchClientMetadataResource: MetadataFetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).protocol !== "https:") throw new TypeError("Client metadata is fetched over https only");
  return fetch(request, { redirect: "manual" });
};

interface Registry {
  app: Hono;
  refresher: Refresher;
  /** better-auth's setup and its one-time check of the D1 schema, which every auth request waits on. */
  ready: Promise<unknown>;
}

function create(env: Env): Registry {
  const settings = env as unknown as Record<string, string | undefined>;
  // A random secret per isolate would break every session and connector on the next isolate.
  if (!settings.GENUI_AUTH_SECRET) throw new Error("GENUI_AUTH_SECRET is not set. Run: wrangler secret put GENUI_AUTH_SECRET");
  const db = d1Database(env.DB);
  const config = authConfigFromEnv(settings);
  const { app, store, refresher } = createRegistryApp(db, { assets, baseURL: config.baseURL });
  const auth = enableManagement(app, db, store, config, { assets, fetchClientMetadataResource });
  return { app, refresher, ready: auth.$context.then((context) => context.checkSchema?.()) };
}

// One registry per isolate: the bindings and settings don't change between its requests.
let registry: Registry | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!registry) {
      registry = create(env);
      // Workers cancel a request's unfinished I/O when it ends (or its client leaves). better-auth's setup
      // runs once per isolate and every later request waits on it, so it must outlive this request.
      ctx.waitUntil(registry.ready);
    }
    await registry.ready;
    const response = await registry.app.fetch(request, env, ctx);
    // A change starts its refresh URL calls during the request: keep the isolate until they're done.
    ctx.waitUntil(registry.refresher.idle());
    return response;
  },
};
