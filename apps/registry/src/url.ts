import { isIP } from "node:net";

/** Loopback, private and link-local hosts: a workspace's refresh URL must not reach the registry's own network. */
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
 * Why a refresh URL may not be called, or undefined when it may. Public https only, unless the
 * registry allows private addresses (self-hosted installs, tests). Host names that resolve to a
 * private address are not caught here.
 */
export function refreshUrlError(url: string, allowPrivate = false): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The refresh URL is not a valid URL.";
  }
  if (allowPrivate) return /^https?:$/.test(parsed.protocol) ? undefined : "The refresh URL must use http or https.";
  if (parsed.protocol !== "https:") return "The refresh URL must use https.";
  if (privateHost(parsed.hostname)) return "The refresh URL must be a public address.";
  return undefined;
}
