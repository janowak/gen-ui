import "./style.css";
import { $ } from "./client";

// `app-mcp login` opens this page with the loopback port it listens on and its PKCE challenge.
const params = new URLSearchParams(location.search);
const request = {
  port: Number(params.get("port")),
  state: params.get("state") ?? "",
  challenge: params.get("challenge") ?? "",
  device: (params.get("device") ?? "").trim() || "this computer",
};

const allow = $<HTMLButtonElement>("allow");
const deny = $<HTMLButtonElement>("deny");
const error = $<HTMLDivElement>("error");
$<HTMLElement>("device").textContent = request.device;

const response = await fetch("/cli/workspace");
// Not signed in: sign in first, then come back here (sign-in.ts follows ?next=/cli?…).
if (response.status === 401) location.replace(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
const context = (await response.json()) as { workspace?: string; admin?: boolean; error?: string };
$<HTMLElement>("workspace").textContent = context.workspace ?? "";
if (context.admin) allow.disabled = false;
else {
  // Nothing to decide: say why, without buttons that can't work.
  allow.parentElement!.hidden = true;
  error.textContent = context.error ?? "Only workspace admins can connect the CLI. Ask an admin for a publish token.";
}

allow.onclick = async () => {
  allow.disabled = deny.disabled = true;
  const res = await fetch("/cli/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  // The CLI's own page on 127.0.0.1 takes over and says it is connected.
  if (body.url) location.href = body.url;
  else {
    deny.disabled = false;
    error.textContent = body.error ?? "Could not connect the CLI. Run app-mcp login again.";
  }
};

deny.onclick = () => {
  $<HTMLElement>("ask").hidden = true;
  $<HTMLElement>("done").hidden = false;
  $<HTMLElement>("title").textContent = "Not connected";
};
