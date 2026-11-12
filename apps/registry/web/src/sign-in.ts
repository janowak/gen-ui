import "./style.css";
import { $, authClient, follow } from "./client";

interface Options {
  github: boolean;
  google: boolean;
  sso: { providerId: string; name: string } | null;
  password: boolean;
}

const error = $<HTMLDivElement>("error");
const fail = (message?: string) => (error.textContent = message ?? "Sign-in failed. Try again.");

// An AI assistant's OAuth flow brings a signed query; without one, this is a sign-in to the web console.
const oauth = new URLSearchParams(location.search).has("sig");
// `app-mcp login` sends people here with ?next=/cli?…; anything else lands on the console.
const next = new URLSearchParams(location.search).get("next");
const cli = Boolean(next?.startsWith("/cli?"));
const CONSOLE = cli ? next! : "/manage";
if (!oauth) $<HTMLParagraphElement>("lead").textContent = cli ? "to connect the app-mcp CLI." : "to manage your workspace.";
// A failed social sign-in comes back with ?error=.
const returned = new URLSearchParams(location.search).get("error");
if (returned) fail(returned.replaceAll("_", " "));

const options = (await fetch("/auth/options").then((r) => r.json())) as Options;
const providers = $<HTMLDivElement>("providers");
providers.style.cssText = "display:flex;flex-direction:column;gap:8px";

/** In an OAuth flow the provider's callback resumes it; otherwise it lands on the console. */
const social = (provider: string) =>
  authClient.signIn.social({ provider: provider as "github", ...(oauth ? {} : { callbackURL: CONSOLE, errorCallbackURL: cli ? `/sign-in?next=${encodeURIComponent(next!)}` : "/sign-in" }) });

function providerButton(label: string, start: () => Promise<{ data: unknown; error: { message?: string } | null }>) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onclick = async () => {
    button.disabled = true;
    const { data, error: err } = await start();
    if (err) {
      button.disabled = false;
      fail(err.message);
    } else follow(data);
  };
  providers.append(button);
}

if (options.sso) {
  const { providerId, name } = options.sso;
  // Generic OIDC providers register as social providers under their providerId.
  providerButton(`Continue with ${name}`, () => social(providerId));
}
if (options.github) providerButton("Continue with GitHub", () => social("github"));
if (options.google) providerButton("Continue with Google", () => social("google"));

if (options.password) {
  const form = $<HTMLFormElement>("password");
  const name = $<HTMLInputElement>("name");
  const submit = $<HTMLButtonElement>("submit");
  const toggle = $<HTMLButtonElement>("toggle");
  let signUp = false;
  form.hidden = false;
  if (!providers.childElementCount) form.querySelector(".divider")?.remove();

  toggle.onclick = () => {
    signUp = !signUp;
    name.hidden = !signUp;
    name.required = signUp;
    submit.textContent = signUp ? "Create account" : "Sign in";
    toggle.textContent = signUp ? "I already have an account" : "Create an account";
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const email = $<HTMLInputElement>("email").value;
    const password = $<HTMLInputElement>("pw").value;
    const { data, error: err } = signUp
      ? await authClient.signUp.email({ email, password, name: name.value || email })
      : await authClient.signIn.email({ email, password });
    if (err) {
      submit.disabled = false;
      fail(err.message);
    } else if (!oauth) location.href = CONSOLE;
    else if (!follow(data)) {
      submit.disabled = false;
      fail("Signed in, but the authorization request has expired. Start again from your AI assistant.");
    }
  };
}

if (!options.password && !providers.childElementCount) fail("No sign-in method is configured on this registry.");
