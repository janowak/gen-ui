import { createServer, type ViteDevServer } from "vite";

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
