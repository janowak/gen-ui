import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import type { Credential } from "./credentials.js";

/** How long the person has to click Allow in the browser. */
const WAIT_MS = 5 * 60 * 1000;

const page = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>${title} · app-mcp</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color-scheme:light dark}main{max-width:360px;padding:24px}h1{font-size:18px}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
        : ["xdg-open", [url]];
  // No browser (a server, a container) is fine: the URL is printed too.
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

export interface LoginResult extends Credential {
  /** The workspace's end-user MCP in prod: what customers add as a connector. */
  mcp: string;
}

/**
 * Signs in through the browser: the registry's /cli page asks the signed-in admin to allow this
 * computer, then sends a one-time code to a port only this process listens on. The code is traded,
 * with a verifier that never left this process, for an admin token.
 */
export async function login(url: string, options: { browser: boolean; log(line: string): void }): Promise<LoginResult> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      if (!req.url?.startsWith("/callback") || query.get("state") !== state || !query.get("code")) {
        res.writeHead(400, { "content-type": "text/html" }).end(page("Not connected", "This link isn't from the app-mcp login that is waiting."));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(page("The CLI is connected", "You can close this tab and go back to your terminal."));
      finish(() => resolve(query.get("code")!));
    });
    const timer = setTimeout(() => finish(() => reject(new Error("nobody allowed the sign-in within 5 minutes. Run app-mcp login again."))), WAIT_MS);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      settle();
    };
    server.on("error", reject);
    // Loopback only: nothing else on the network can reach the port.
    server.listen(0, "127.0.0.1", () => {
      const authorize = new URL(`${url}/cli`);
      authorize.searchParams.set("port", String((server.address() as AddressInfo).port));
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("challenge", challenge);
      authorize.searchParams.set("device", hostname().slice(0, 60));
      options.log(`Allow the CLI in your browser to finish signing in:\n\n  ${authorize.href}\n\nWaiting for you to click Allow…`);
      if (options.browser) openBrowser(authorize.href);
    });
  });

  const res = await fetch(`${url}/cli/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<LoginResult> & { error?: string };
  if (!res.ok || !body.token || !body.workspace || !body.mcp) throw new Error(body.error ?? `the registry answered ${res.status}`);
  return { token: body.token, workspace: body.workspace, mcp: body.mcp };
}
