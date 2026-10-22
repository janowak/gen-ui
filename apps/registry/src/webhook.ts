import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { SubmitResult, type Recipe } from "@genui/format";

const TIMEOUT_MS = 5000;
const UNAVAILABLE: SubmitResult = { ok: false, formError: "We couldn't check your answers. Please try again." };

/** Loopback, private and link-local hosts: a workspace's webhook must not reach the registry's own network. */
function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === "::" || host === "::1" || host.startsWith("::ffff:") || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

/**
 * Why a webhook URL may not be called, or undefined when it may. Public https only, unless the
 * registry allows private webhooks (self-hosted installs, tests). Host names that resolve to a
 * private address are not caught here.
 */
export function webhookUrlError(url: string, allowPrivate = false): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The webhook URL is not a valid URL.";
  }
  if (allowPrivate) return /^https?:$/.test(parsed.protocol) ? undefined : "The webhook URL must use http or https.";
  if (parsed.protocol !== "https:") return "The webhook URL must use https.";
  if (privateHost(parsed.hostname)) return "The webhook URL must be a public address.";
  return undefined;
}

/** HMAC-SHA256 of `<timestamp>.<body>`; sent as `x-genui-signature: t=<timestamp>,v1=<hex>`. */
export function signature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface WebhookCall {
  recipe: Recipe;
  values: Record<string, unknown>;
  workspaceId: string;
  secret: string;
  allowPrivate?: boolean;
  fetch?: typeof fetch;
}

/**
 * Posts a recipe's values to its validation webhook and returns what the form shows: the webhook's
 * { ok, fieldErrors?, formError?, message? }, or a try-again error when it can't be reached or
 * answers something else. The values pass through; nothing is stored or logged.
 */
export async function validateWithWebhook({ recipe, values, workspaceId, secret, allowPrivate, fetch: doFetch = fetch }: WebhookCall): Promise<SubmitResult> {
  const url = recipe.validate?.url;
  if (!url) return { ok: true };
  const invalid = webhookUrlError(url, allowPrivate);
  if (invalid) {
    console.warn(`[genui] recipe ${recipe.name}: ${invalid}`);
    return UNAVAILABLE;
  }
  const body = JSON.stringify({ type: "recipe.validate", workspace: workspaceId, recipe: recipe.name, values });
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genui-signature": `t=${timestamp},v1=${signature(secret, timestamp, body)}` },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed = SubmitResult.safeParse(await res.json().catch(() => undefined));
    // A rejection counts whatever the status (422 is common); an acceptance needs a 2xx.
    if (parsed.success && (res.ok || !parsed.data.ok)) return parsed.data;
    console.warn(`[genui] recipe ${recipe.name}: webhook answered HTTP ${res.status}${parsed.success ? "" : " without a valid result"}`);
  } catch (error) {
    console.warn(`[genui] recipe ${recipe.name}: webhook failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return UNAVAILABLE;
}
