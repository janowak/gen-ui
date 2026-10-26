import { build, createServer, type Rolldown, type ViteDevServer } from "vite";

export interface DevOptions {
  /** Component directory with its vite.config. */
  root: string;
  port?: number;
  open?: boolean;
}

/** Starts the component's Vite dev server (its own vite.config) with the genui dev host at `/`. */
export async function startDev(options: DevOptions): Promise<ViteDevServer> {
  const server = await createServer({ root: options.root, server: { port: options.port, open: options.open } });
  if (!server.config.plugins.some((plugin) => plugin.name === "genui:dev")) {
    await server.close();
    throw new Error(`${options.root}: add genui() from @genui/kit/vite to the plugins in vite.config.`);
  }
  await server.listen();
  return server;
}

export interface WatchBuildOptions {
  /** Component directory with its vite.config. */
  root: string;
  /** After every build: no error when dist/ has the new bundle and manifest. */
  onBuild?(error?: Error): void;
}

export interface BuildWatcher {
  close(): Promise<void>;
}

/**
 * `vite build --watch` with the component's own vite.config, quietly: `genui serve` reports builds
 * itself, and over stdio, stdout belongs to the MCP protocol. Resolves after the first build.
 */
export async function watchBuild(options: WatchBuildOptions): Promise<BuildWatcher> {
  const watcher = (await build({ root: options.root, logLevel: "silent", build: { watch: {} } })) as Rolldown.RolldownWatcher;
  let first: (() => void) | undefined;
  const built = new Promise<void>((resolve) => (first = resolve));
  watcher.on("event", (event) => {
    if (event.code !== "BUNDLE_END" && event.code !== "ERROR") return;
    void event.result.close();
    options.onBuild?.(event.code === "ERROR" ? event.error : undefined);
    first?.();
    first = undefined;
  });
  await built;
  return { close: () => watcher.close() };
}
