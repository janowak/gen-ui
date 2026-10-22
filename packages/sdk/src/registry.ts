import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { CHANNELS, type Catalog, type Channel } from "@genui/format";

export interface RegistryOptions {
  /** Registry base URL, e.g. https://registry.example.com */
  url: string;
  /** Workspace server token (scope: server). */
  token: string;
  /** Background refresh interval. Default 30s; 0 disables polling. */
  refreshSeconds?: number;
  /** File where the last good snapshot is kept, so a restart works while the registry is down. */
  cacheFile?: string;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn">;
}

/** A channel's catalog plus every bundle it references, fetched and hash-verified. */
export interface Snapshot {
  catalog: Catalog;
  bundles: Record<string, string>;
}

export interface RegistryClient {
  /** Resolves after the first load attempt, successful or not. */
  ready(): Promise<void>;
  /** Last good snapshot for a channel, or undefined if none was ever loaded. */
  snapshot(channel: Channel): Snapshot | undefined;
  refresh(): Promise<void>;
  /** Called when a channel's snapshot changes. Returns an unsubscribe function. */
  onChange(listener: (channel: Channel) => void): () => void;
  close(): void;
}

const hashOf = (html: string) => createHash("sha256").update(html).digest("hex").slice(0, 16);

/**
 * Pulls catalogs from the registry and keeps the last good version of each channel.
 * A failed refresh never replaces a working snapshot.
 */
export function createRegistryClient(options: RegistryOptions): RegistryClient {
  const doFetch = options.fetch ?? fetch;
  const logger = options.logger ?? console;
  const base = options.url.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${options.token}` };
  const snapshots: Partial<Record<Channel, Snapshot>> = {};
  const listeners = new Set<(channel: Channel) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function get(path: string): Promise<Response> {
    const res = await doFetch(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  }

  async function load(channel: Channel): Promise<void> {
    const catalog = (await (await get(`/v1/catalog?channel=${channel}`)).json()) as Catalog;
    const previous = snapshots[channel];
    const bundles: Record<string, string> = {};
    for (const component of catalog.components) {
      const cached = previous?.bundles[component.hash];
      const html = cached ?? (await (await get(`/v1/bundles/${component.hash}`)).text());
      if (hashOf(html) !== component.hash) throw new Error(`Bundle ${component.name}@${component.version} failed hash verification`);
      bundles[component.hash] = html;
    }
    const next = { catalog, bundles };
    if (JSON.stringify(previous?.catalog) === JSON.stringify(catalog)) return;
    snapshots[channel] = next;
    for (const listener of listeners) listener(channel);
  }

  async function refresh(): Promise<void> {
    const results = await Promise.allSettled(CHANNELS.map(load));
    results.forEach((r, i) => {
      if (r.status === "rejected") logger.warn(`[genui] registry ${CHANNELS[i]} refresh failed, keeping last good version: ${r.reason}`);
    });
    if (options.cacheFile && results.some((r) => r.status === "fulfilled")) {
      await writeFile(options.cacheFile, JSON.stringify(snapshots)).catch((e) => logger.warn(`[genui] could not write cache: ${e}`));
    }
  }

  const initial = (async () => {
    if (options.cacheFile) {
      try {
        Object.assign(snapshots, JSON.parse(await readFile(options.cacheFile, "utf8")));
      } catch {
        // No cache yet.
      }
    }
    await refresh();
  })();

  const interval = options.refreshSeconds ?? 30;
  if (interval > 0) {
    timer = setInterval(() => void refresh(), interval * 1000);
    timer.unref?.();
  }

  return {
    ready: () => initial,
    snapshot: (channel) => snapshots[channel],
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (timer) clearInterval(timer);
      listeners.clear();
    },
  };
}
