/**
 * Share links that store nothing: the card data rides in the URL fragment, deflated and base64url-encoded.
 * Browsers never send the fragment to the server, so the static share page renders it without app-mcp
 * seeing or keeping it. Self-contained (no imports) so other demo apps can copy it as is.
 */

const PREFIX = "#d=";

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The fragment (`#d=…`) for `data`. */
export async function encodeShare(data: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  return PREFIX + toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

/** The data in a fragment from `encodeShare`, or undefined if there is none or it is damaged. Validate it after. */
export async function decodeShare(hash: string): Promise<unknown> {
  if (!hash.startsWith(PREFIX)) return undefined;
  try {
    const bytes = await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream("deflate-raw"));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** `base` (the share page) with the data in its fragment. */
export async function shareUrl(base: string, data: unknown): Promise<string> {
  const url = new URL(base);
  url.hash = (await encodeShare(data)).slice(1);
  return url.toString();
}

/** Which chat the cards were made in, for the watermark: from the host's name, else "Claude". */
export function hostLabel(hostName: string | undefined): string {
  const name = (hostName ?? "").toLowerCase();
  if (name.includes("chatgpt") || name.includes("openai")) return "ChatGPT";
  if (name.includes("vscode") || name.includes("visual studio")) return "VS Code";
  return "Claude";
}

export const BACKLINK = "https://app-mcp.com/?ref=wrapped";

/** "made in Claude with app-mcp", linking to app-mcp. */
export function watermark(host: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "watermark";
  link.href = BACKLINK;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `made in ${host} with app-mcp`;
  return link;
}
