import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage =
  "Usage: pnpm publish:packages [--dry-run]\n\nBuild, check and publish all seven npm packages at their current version.\n--dry-run validates and previews without publishing; allowed with local edits or in a worktree.";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}
if (args.some((arg) => arg !== "--dry-run")) fail(usage);
const dryRun = args.includes("--dry-run");

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) fail(result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
  .map(
    (entry) =>
      JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) as {
        name: string;
        version: string;
        private?: boolean;
      },
  )
  .filter((pkg) => !pkg.private);
const versions = new Set(packages.map((pkg) => pkg.version));
if (packages.length !== 7 || versions.size !== 1) {
  fail(`Expected seven npm packages with the same version. Found:\n${packages.map((pkg) => `${pkg.name}@${pkg.version}`).join("\n")}`);
}

if (!dryRun) {
  if (git("rev-parse", "--path-format=absolute", "--git-dir") !== git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    fail("Publish from the main checkout. Use --dry-run to preview from a worktree.");
  if (git("branch", "--show-current") !== "master") fail("Publish from master.");
  if (git("status", "--porcelain"))
    fail("Commit your version bumps and other changes before publishing. Use --dry-run to preview local edits.");
}

function pnpm(...args: string[]): void {
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`${dryRun ? "Previewing" : "Publishing"} ${packages.length} npm packages at ${[...versions][0]}.`);
pnpm("build");
pnpm("check");
pnpm("typecheck");
pnpm("test");
pnpm("-r", "--filter", "./packages/*", "publish", "--access", "public", ...(dryRun ? ["--dry-run", "--no-git-checks"] : []));
