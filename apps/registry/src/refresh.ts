import type { EnvironmentChange, LastRefresh, Store } from "./store.js";
import { webhookUrlError } from "./webhook.js";

const TIMEOUT_MS = 3000;

export interface RefreshOptions {
  /** Let refresh URLs use http and private addresses. For self-hosted installs and tests. */
  allowPrivate?: boolean;
  fetch?: typeof fetch;
}

export interface Refresher {
  /** Resolves once no refresh call is in flight. */
  idle(): Promise<void>;
  close(): void;
}

/**
 * Calls an environment's refresh URL after every change to what it serves (a publish, a theme or
 * recipe save, from the API or the registry MCP), so the company's server re-lists genui's tools
 * now instead of at its next check. Only the change's environment and revision are sent; the
 * answer is recorded as the environment's last refresh, never read. A failed call never fails the
 * write: the SDK's own check catches up.
 */
export function refreshServers(store: Store, { allowPrivate = false, fetch: doFetch = fetch }: RefreshOptions = {}): Refresher {
  // One call per environment at a time; changes made meanwhile are sent together once it's done.
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  async function call({ workspaceId, environment }: EnvironmentChange): Promise<void> {
    const target = await store.environment(workspaceId, environment);
    if (!target?.refreshUrl) return;
    const invalid = webhookUrlError(target.refreshUrl, allowPrivate, "refresh URL");
    let result: LastRefresh;
    if (invalid) {
      result = { at: new Date().toISOString(), ok: false, error: invalid };
    } else {
      try {
        const res = await doFetch(target.refreshUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "genui.refresh", environment, revision: target.revision }),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await res.body?.cancel();
        result = { at: new Date().toISOString(), ok: res.ok, status: res.status };
      } catch (error) {
        result = { at: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!result.ok) console.warn(`[genui] refresh URL of ${environment} failed: ${result.error ?? `HTTP ${result.status}`}`);
    await store.setLastRefresh(workspaceId, environment, result);
  }

  function start(change: EnvironmentChange): void {
    const key = `${change.workspaceId}:${change.environment}`;
    if (running.has(key)) {
      again.add(key);
      return;
    }
    const done = call(change).finally(() => {
      running.delete(key);
      if (again.delete(key)) start(change);
    });
    running.set(key, done);
  }

  const unsubscribe = store.onChange(start);

  return {
    async idle() {
      while (running.size) await Promise.all(running.values());
    },
    close: unsubscribe,
  };
}
