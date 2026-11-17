import "./style.css";
import { $, authClient, follow } from "./client";

/**
 * Consent for an MCP client (Claude, ChatGPT…). The client acts as the person in every workspace they're
 * in: it manages their active one, and its switch_workspace tool moves to another.
 */
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

type Workspace = { id: string; name: string; active: boolean };
fetch("/workspaces")
  .then((res) => (res.ok ? (res.json() as Promise<{ workspaces: Workspace[] }>) : { workspaces: [] }))
  .then(({ workspaces }) => {
    if (workspaces.length < 2) return;
    $<HTMLElement>("workspace").textContent = workspaces.find((w) => w.active)?.name ?? "";
    $<HTMLElement>("workspace-line").hidden = false;
  })
  .catch(() => {});

async function answer(accept: boolean) {
  allow.disabled = deny.disabled = true;
  const { data, error: failure } = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
  if (failure || !follow(data)) {
    allow.disabled = deny.disabled = false;
    error.textContent = failure?.message ?? "Could not complete the request. Start again from your AI assistant.";
  }
}

allow.onclick = () => void answer(true);
deny.onclick = () => void answer(false);
