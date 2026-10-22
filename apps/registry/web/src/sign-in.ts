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

const options = (await fetch("/auth/options").then((r) => r.json())) as Options;
const providers = $<HTMLDivElement>("providers");
providers.style.cssText = "display:flex;flex-direction:column;gap:8px";

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
  providerButton(`Continue with ${name}`, () => authClient.signIn.social({ provider: providerId as "github" }));
}
if (options.github) providerButton("Continue with GitHub", () => authClient.signIn.social({ provider: "github" }));
if (options.google) providerButton("Continue with Google", () => authClient.signIn.social({ provider: "google" }));

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
    } else if (!follow(data)) {
      submit.disabled = false;
      fail("Signed in, but the authorization request has expired. Start again from your AI assistant.");
    }
  };
}

if (!options.password && !providers.childElementCount) fail("No sign-in method is configured on this registry.");
