// Deploys run from the main checkout, never from an agent's worktree: `node scripts/main-checkout-only.ts && <deploy>`.
import { execFileSync } from "node:child_process";

const [gitDir, commonDir] = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { encoding: "utf8" }).trim().split("\n");
if (gitDir !== commonDir) {
  console.error("Refusing to deploy from a worktree: deploy from the main checkout.");
  process.exit(1);
}
