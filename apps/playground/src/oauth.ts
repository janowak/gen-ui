import type { OAuthClientProvider } from "@modelcontextprotocol/client";

type ClientInfo = Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>;
type Tokens = Awaited<ReturnType<OAuthClientProvider["tokens"]>>;

const CALLBACK = "oauth-callback";

/**
 * Browser OAuth for the playground, like Claude's connector flow: on 401 the MCP SDK discovers the
 * authorization server, registers this client (dynamic registration in dev), and redirects here.
 * State lives in localStorage per server URL; the code verifier survives the redirect.
 */
export class PlaygroundOAuth implements OAuthClientProvider {
  constructor(private readonly server: string) {}

  private key(name: string) {
    return `genui-playground:${this.server}:${name}`;
  }
  private read<T>(name: string): T | undefined {
    try {
      const raw = localStorage.getItem(this.key(name));
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  }
  private write(name: string, value: unknown) {
    try {
      localStorage.setItem(this.key(name), JSON.stringify(value));
    } catch {
      // Storage blocked: the flow will just ask again.
    }
  }

  get redirectUrl() {
    return `${location.origin}/?${CALLBACK}=1`;
  }

  get clientMetadata() {
    return {
      client_name: "genui playground",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.read<NonNullable<ClientInfo>>("client");
  }
  saveClientInformation(info: NonNullable<ClientInfo>) {
    this.write("client", info);
  }
  tokens() {
    return this.read<NonNullable<Tokens>>("tokens");
  }
  saveTokens(tokens: NonNullable<Tokens>) {
    this.write("tokens", tokens);
  }
  saveCodeVerifier(verifier: string) {
    this.write("verifier", verifier);
  }
  codeVerifier() {
    return this.read<string>("verifier") ?? "";
  }
  redirectToAuthorization(url: URL) {
    // Remember which server and channel the redirect belongs to.
    sessionStorage.setItem("genui-playground:return", location.search);
    location.href = url.toString();
  }

  signOut() {
    for (const name of ["client", "tokens", "verifier"]) localStorage.removeItem(this.key(name));
  }
}

/** If this page load is the OAuth redirect, returns the callback params and restores the original query. */
export function takeCallback(): URLSearchParams | undefined {
  const params = new URLSearchParams(location.search);
  if (!params.has(CALLBACK)) return undefined;
  const original = sessionStorage.getItem("genui-playground:return") ?? "";
  history.replaceState(null, "", `/${original}`);
  return params;
}
