import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

// Run by deploy after the main-checkout guard. Retain every old built-in asset in R2.
const run = promisify(execFile);
const bucket = process.env.APP_MCP_ASSET_BUCKET ?? "app-mcp-assets";
for (const key of await readdir("dist-static/assets")) {
  if (!/^[a-f0-9]{64}\.(js|css)$/.test(key)) continue;
  await run("pnpm", [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--remote",
    "--file",
    `dist-static/assets/${key}`,
    "--content-type",
    key.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
    "--cache-control",
    "public, max-age=31536000, immutable",
  ]);
}
