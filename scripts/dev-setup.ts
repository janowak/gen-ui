// pnpm dev:setup: gets this checkout ready to run and test. Safe to re-run. Node built-ins only: it runs before pnpm install.
//
// Main checkout: install and build; the ports are the ones in .claude/launch.json.
// Linked worktree (an agent's): its own block of ports, a seeded registry on its own SQLite file, and
// .env.worktree, which the registry, the demo and `pnpm genui` load after .env.local, so its values win.
// .claude/launch.json gets the worktree's ports, hidden from git with --skip-worktree. No wrangler, no tunnel.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dirname, "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (command: string, args: string[]) => {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
  } catch {
    console.error(`dev:setup: ${command} ${args.join(" ")} failed`);
    process.exit(1);
  }
};
const readEnv = (path: string): Record<string, string> =>
  existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>) : {};

const SERVICES = ["registry", "serve", "demo", "playground", "site"] as const;
type Ports = Record<(typeof SERVICES)[number], number>;
/** Slot n ≥ 1 gets 40000 + 10n and the next four ports; the main checkout keeps the usual ones. */
const slotPorts = (slot: number) => Object.fromEntries(SERVICES.map((service, i) => [service, 40000 + slot * 10 + i])) as Ports;

const [gitDir, commonDir] = git("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").split("\n");
if (gitDir === commonDir) {
  // Nothing to override here; the file only stops Node's "not found" notice on every start.
  if (!existsSync(join(root, ".env.worktree")))
    writeFileSync(
      join(root, ".env.worktree"),
      "# Main checkout: nothing overrides .env.local. In a worktree, pnpm dev:setup writes its ports, URLs and tokens here.\n",
    );
  run("pnpm", ["install"]);
  run("pnpm", ["build"]);
  console.log(
    "\nMain checkout ready: start services from .claude/launch.json (registry 4000, serve 4100, demo 3001, playground 5173, site 5180).",
  );
  process.exit(0);
}

// .worktreeinclude copies .env.local into worktrees Claude Code creates; this covers `git worktree add`.
const mainCheckout = dirname(commonDir);
const local = join(root, ".env.local");
if (!existsSync(local) && existsSync(join(mainCheckout, ".env.local"))) copyFileSync(join(mainCheckout, ".env.local"), local);

const envPath = join(root, ".env.worktree");
const previous = readEnv(envPath);
const shared = readEnv(local);

const listening = (port: number, host: string) =>
  new Promise<boolean>((done) => {
    const socket = connect({ port, host })
      .once("connect", () => (socket.destroy(), done(true)))
      .once("error", () => done(false));
  });

/**
 * Claims a slot with a file in the shared git dir, created exclusively, so worktrees set up at the same
 * moment never get the same one. A claim whose worktree is gone is taken over.
 */
function claim(slot: number): boolean {
  const file = join(commonDir, `genui-dev-slot-${slot}`);
  try {
    writeFileSync(file, root, { flag: "wx" });
    return true;
  } catch {
    const owner = readFileSync(file, "utf8");
    if (owner !== root && existsSync(owner)) return false;
    writeFileSync(file, root);
    return true;
  }
}

/** The first slot whose ports nothing listens on and that no other worktree has claimed. */
async function pickSlot(): Promise<number> {
  for (let slot = 1; slot < 100; slot++) {
    const ports = Object.values(slotPorts(slot));
    const busy = await Promise.all(ports.flatMap((port) => [listening(port, "127.0.0.1"), listening(port, "::1")]));
    if (!busy.includes(true) && claim(slot)) return slot;
  }
  throw new Error("dev:setup: no free port slot");
}

const slot = Number(previous.GENUI_DEV_SLOT) && claim(Number(previous.GENUI_DEV_SLOT)) ? Number(previous.GENUI_DEV_SLOT) : await pickSlot();
const ports = slotPorts(slot);
const registryUrl = `http://localhost:${ports.registry}`;

const values: Record<string, string> = {
  GENUI_DEV_SLOT: String(slot),
  // The registry's port; the demo has its own variable so the two don't share it.
  PORT: String(ports.registry),
  GENUI_DEMO_PORT: String(ports.demo),
  // Replaces the main checkout's tunnel: the worktree's registry is only reached locally.
  GENUI_PUBLIC_URL: registryUrl,
  GENUI_URL: registryUrl,
  GENUI_PASSWORD_LOGIN: "true",
};
// Shared values come from .env.local; made up here only when it has none.
const own = (key: string, make: () => string) => {
  if (!shared[key]) values[key] = previous[key] ?? make();
};
own("GENUI_AUTH_SECRET", () => randomBytes(32).toString("hex"));
own("GENUI_DEV_EMAIL", () => "dev@genui.test");
own("GENUI_DEV_PASSWORD", () => randomBytes(12).toString("base64url"));
for (const key of ["GENUI_TOKEN", "GENUI_MCP_URL", "GENUI_MCP_TOKEN"]) if (previous[key]) values[key] = previous[key];

function writeEnv() {
  const header = [
    "# Generated by pnpm dev:setup for this worktree. Loaded after .env.local, so these win. Re-run setup to refresh.",
    `# Ports: ${SERVICES.map((service) => `${service} ${ports[service]}`).join(", ")}`,
  ];
  writeFileSync(envPath, [...header, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ""].join("\n"));
}
writeEnv();

const pnpm = (filter: string, ...args: string[]) => ({ runtimeExecutable: "pnpm", runtimeArgs: ["--filter", filter, ...args] });
const vite = (filter: string, port: number) => pnpm(filter, "exec", "vite", "--port", String(port), "--strictPort");
const launch = {
  version: "0.0.1",
  configurations: [
    {
      name: "serve",
      runtimeExecutable: "node",
      runtimeArgs: ["packages/cli/dist/cli.js", "serve", "examples/rating", "--port", String(ports.serve)],
      port: ports.serve,
    },
    { name: "demo", ...pnpm("@app-mcp/demo", "start"), port: ports.demo },
    { name: "playground", ...vite("@app-mcp/playground", ports.playground), port: ports.playground },
    { name: "registry", ...pnpm("@app-mcp/registry", "start"), port: ports.registry },
    { name: "site", ...vite("@app-mcp/site", ports.site), port: ports.site },
  ],
};
writeFileSync(join(root, ".claude/launch.json"), `${JSON.stringify(launch, null, 2)}\n`);
git("update-index", "--skip-worktree", ".claude/launch.json");

run("pnpm", ["install"]);
run("pnpm", ["build"]);

console.log("\n$ pnpm --filter @app-mcp/registry run seed");
const seeded = execFileSync("pnpm", ["--filter", "@app-mcp/registry", "run", "seed"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
Object.assign(values, JSON.parse(seeded.trim().split("\n").at(-1)!) as Record<string, string>);
writeEnv();

const demo = `http://localhost:${ports.demo}/mcp`;
console.log(`
Worktree ready (slot ${slot}). Start services by name from .claude/launch.json:
  registry    ${registryUrl}  (sign in with GENUI_DEV_EMAIL / GENUI_DEV_PASSWORD from .env.worktree or .env.local)
  serve       http://localhost:${ports.serve}/mcp
  demo        ${demo}  (uses this registry: GENUI_MCP_URL)
  playground  http://localhost:${ports.playground}/?server=${demo}
  site        http://localhost:${ports.site}
CLI against this registry: pnpm genui <command>`);
