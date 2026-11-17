import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * What `app-mcp login` keeps for a registry: a token for the person, who it signs in, and the workspace
 * commands use unless --workspace names another (`app-mcp use` changes it). Kept here, not on the
 * registry, so switching workspace in the browser never moves where this machine publishes.
 */
export interface Credential {
  token: string;
  email?: string;
  workspace?: { id: string; name: string };
}

/** One file for every registry this machine is signed in to, keyed by registry URL. Only the user can read it. */
export const credentialsFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "app-mcp", "credentials.json");

function readAll(): Record<string, Credential> {
  try {
    return JSON.parse(readFileSync(credentialsFile(), "utf8")) as Record<string, Credential>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Credential>) {
  const file = credentialsFile();
  if (!Object.keys(all).length) return rmSync(file, { force: true });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  // An existing file keeps its mode on write.
  chmodSync(file, 0o600);
}

export const readCredential = (url: string): Credential | undefined => readAll()[url];

export function saveCredential(url: string, credential: Credential) {
  writeAll({ ...readAll(), [url]: credential });
}

export function removeCredential(url: string) {
  const { [url]: _removed, ...rest } = readAll();
  writeAll(rest);
}
