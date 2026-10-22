import "./style.css";
import { $, authClient, follow } from "./client";

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

async function answer(accept: boolean) {
  allow.disabled = deny.disabled = true;
  // $fetch keeps the oauthProviderClient hook that attaches the signed OAuth query.
  const { data, error } = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
  if (error || !follow(data)) {
    allow.disabled = deny.disabled = false;
    $<HTMLDivElement>("error").textContent = error?.message ?? "Could not complete the request. Start again from your AI assistant.";
  }
}

allow.onclick = () => void answer(true);
deny.onclick = () => void answer(false);
