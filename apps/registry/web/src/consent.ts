import "./style.css";
import { $, authClient, follow } from "./client";

/**
 * Consent for an MCP client (Claude, ChatGPT…). A person in several workspaces first lands here at
 * /consent/workspace to pick the one the client manages: picking makes it their active workspace, which
 * better-auth stores as the consent's reference and keeps for the client's tokens.
 */
const picking = location.pathname === "/consent/workspace";

const params = new URLSearchParams(location.search);
const clientId = params.get("client_id") ?? "";
$<HTMLElement>("client").textContent = clientId || "Unknown app";
// Show the registered name when available (a CIMD client_id is already a readable URL).
authClient
  .$fetch<{ client_name?: string }>("/oauth2/public-client", { method: "GET", query: { client_id: clientId } })
  .then(({ data }) => {
    if (data?.client_name) $<HTMLElement>("client").textContent = `${data.client_name} (${clientId})`;
  })
  .catch(() => {});
const scopes = $<HTMLUListElement>("scopes");
for (const scope of (params.get("scope") ?? "").split(" ").filter(Boolean)) {
  const item = document.createElement("li");
  item.textContent = scope;
  scopes.append(item);
}

const allow = $<HTMLButtonElement>("allow");
const deny = $<HTMLButtonElement>("deny");
const error = $<HTMLDivElement>("error");
const picker = $<HTMLSelectElement>("workspace-select");

type Workspace = { id: string; name: string; role: string; active: boolean };
const workspaces = await fetch("/workspaces")
  .then((res) => (res.ok ? (res.json() as Promise<{ workspaces: Workspace[] }>) : { workspaces: [] }))
  .then((body) => body.workspaces)
  .catch(() => [] as Workspace[]);

if (picking) {
  $<HTMLElement>("title").textContent = "Pick a workspace";
  $<HTMLElement>("intro").textContent = "This app wants to manage one of your app-mcp workspaces:";
  $<HTMLElement>("ask").hidden = true;
  $<HTMLElement>("pick").hidden = false;
  allow.textContent = "Continue";
  picker.replaceChildren(...workspaces.map((w) => new Option(`${w.name} (${w.role})`, w.id)));
} else if (workspaces.length > 1) {
  // Which one was picked: the active one.
  $<HTMLElement>("workspace").textContent = workspaces.find((w) => w.active)?.name ?? "";
  $<HTMLElement>("workspace-line").hidden = false;
}

const failed = (message?: string) => {
  allow.disabled = deny.disabled = false;
  error.textContent = message ?? "Could not complete the request. Start again from your AI assistant.";
};

async function pick() {
  allow.disabled = deny.disabled = true;
  const res = await fetch("/workspaces/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: picker.value }),
  });
  if (!res.ok) return failed(((await res.json().catch(() => ({}))) as { error?: string }).error);
  // $fetch keeps the oauthProviderClient hook that attaches the signed OAuth query.
  const { data, error } = await authClient.$fetch("/oauth2/continue", { method: "POST", body: { postLogin: true } });
  if (error || !follow(data)) failed(error?.message);
}

async function answer(accept: boolean) {
  allow.disabled = deny.disabled = true;
  const { data, error } = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
  if (error || !follow(data)) failed(error?.message);
}

allow.onclick = () => void (picking ? pick() : answer(true));
deny.onclick = () => void answer(false);
