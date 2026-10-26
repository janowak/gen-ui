# Auth plan

People sign in to genui cloud with Google or GitHub. better-auth, inside the registry at `https://api.app-mcp.com`, is our only login system. Claude and ChatGPT connectors use it, and so does any web page of ours that needs a login.

**Status (2026-10-24)**
- Proposed. Launch needs no code change: the registry already signs people in with Google and GitHub (`GOOGLE_*`, `GITHUB_*`). The work is Google and GitHub setup (§5) and settings (§6).
- Changes V1-PLAN §9 (Hosting) and LANDING-DEPLOY-PLAN §3: `api.app-mcp.com` replaces `registry.` and `mcp.`. Those files aren't edited yet.

---

## 1. One login system, on our server

| Layer | Who | Job |
|---|---|---|
| Identity providers | Google, GitHub | "This is alice@gmail.com, and the email is verified." |
| Login system | better-auth, in the registry | Talks to Google and GitHub, keeps our user list, gives Claude and ChatGPT tokens and our web pages sessions |
| Our app | Registry and MCPs | Asks better-auth who is calling |

```
Claude / ChatGPT ──OAuth──────────┐
                                  ├──▶ better-auth on api.app-mcp.com ──▶ Google, GitHub
our web pages ────session cookie──┘    one user list and workspaces, in our SQLite
```

- **Connectors:** Claude and ChatGPT register themselves (Client ID Metadata Documents), the person signs in and consents, and the token is bound to `https://api.app-mcp.com/mcp`.
- **Web pages:** the same Google and GitHub buttons give a session cookie on `api.app-mcp.com`. Today only `/sign-in` and `/consent` use it. A dashboard would later use the same sessions (§7). The landing page is public and has no login.

**No Auth0.** Auth0 is a hosted login system of the same kind as better-auth. In front of better-auth it would be a second one. In place of better-auth, it can't take Claude and ChatGPT on its own today: an admin imports each client by hand, and it rejects ChatGPT's registration document (forum thread, Sept–Oct 2026). If a cloud customer later wants their company login (Okta, Entra), any OIDC provider plugs in through `GENUI_OIDC_*`. People are matched by verified email, so their accounts carry over.

**Cost:** $0.

## 2. Addresses

| Address | Serves | Cloudflare DNS |
|---|---|---|
| `api.app-mcp.com` | The registry: management MCP `/mcp`, end-user MCP `/w/<workspace>/mcp` and `/w/<workspace>/<environment>/mcp`, `/v1`, `/api/auth/*`, `/sign-in`, `/consent`, `/.well-known/*` | Tunnel, proxied |
| `api-staging.app-mcp.com` | Staging's compose project | Tunnel, proxied |
| `api-dev.app-mcp.com` | Your laptop, through a named tunnel (§6.3) | Tunnel, proxied |
| `app-mcp.com` | Landing, plus `/privacy` and `/terms` for Google's consent screen | [LANDING-DEPLOY-PLAN](LANDING-DEPLOY-PLAN.md) |

- **`api-staging`, not `api.staging`:** Cloudflare's free certificate covers one level of subdomains.
- **One hostname for both MCPs.** Connector URLs still never change when the end-user MCP moves: a tunnel ingress rule (its own container) or a Worker route on `api.app-mcp.com/w/*` (the edge) takes those paths, and the rest keeps going to the registry. `GENUI_HOSTED_URL` isn't needed: hosted URLs share `GENUI_PUBLIC_URL`.

## 3. Sign-in from a connector, step by step

1. Claude calls `https://api.app-mcp.com/mcp` and gets a 401 that points to `/.well-known/oauth-protected-resource/mcp`.
2. Claude identifies itself with its Client ID Metadata Document and opens `/api/auth/oauth2/authorize`.
3. better-auth shows `/sign-in`: **Continue with GitHub**, **Continue with Google**.
4. Google or GitHub returns to `https://api.app-mcp.com/api/auth/callback/google` (or `/github`). better-auth finds or creates the person. In hosted mode, a first sign-in creates a personal workspace.
5. `/consent`, then back to Claude with the token.

## 4. Before you start

- **The name** (LANDING-DEPLOY-PLAN §8). It shows on Google's consent screen and GitHub's authorize page, and Google's brand check compares it with what `app-mcp.com` shows. This plan writes `genui`; use the winner everywhere.
- **Landing live** with `/privacy` and `/terms` (§9.1). Google's consent screen links to them.
- **No VPS needed yet:** §6.3 runs the whole flow from your laptop.

## 5. Setup, in order

### 5.1 Google: one project, two clients

1. [console.cloud.google.com](https://console.cloud.google.com) → new project `genui-auth`.
2. [Google Search Console](https://search.google.com/search-console) → add a **Domain** property `app-mcp.com` → copy the TXT record → add it in Cloudflare DNS → Verify. Google needs it for the authorized domain.
3. **Google Auth Platform → Branding:**
   - App name `genui`, user support email (your Google account, or a Google Group you manage).
   - Home page `https://app-mcp.com`, privacy policy `https://app-mcp.com/privacy`, terms `https://app-mcp.com/terms`.
   - Authorized domain `app-mcp.com`; developer contact email.
   - A logo is optional and sends the app to brand review (a few business days).
4. **Audience:** External → **Publish app**. In Testing, only listed test users can sign in. `openid`, `email` and `profile` are non-sensitive scopes, so there's no security review.
5. **Data access:** add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
6. **Clients → Create client → Web application**, twice. No JavaScript origins.
   - `genui prod`, redirect URI `https://api.app-mcp.com/api/auth/callback/google`
   - `genui dev`, redirect URIs `https://api-staging.app-mcp.com/api/auth/callback/google` and `https://api-dev.app-mcp.com/api/auth/callback/google`

   Separate secrets, so a leaked dev secret can't touch prod.
7. Copy each client ID and secret into your password manager. Secrets are shown once.

### 5.2 GitHub: one OAuth App per environment

A GitHub OAuth App takes a single callback URL, so each host gets its own app. Create them under the GitHub organization that will own the product (a personal account works; apps can be transferred later): **Settings → Developer settings → OAuth Apps → New OAuth App**. OAuth Apps, not GitHub Apps.

| Application name | Homepage URL | Authorization callback URL |
|---|---|---|
| `genui` | `https://app-mcp.com` | `https://api.app-mcp.com/api/auth/callback/github` |
| `genui staging` | `https://app-mcp.com` | `https://api-staging.app-mcp.com/api/auth/callback/github` |
| `genui dev` | `https://app-mcp.com` | `https://api-dev.app-mcp.com/api/auth/callback/github` |

For each: device flow off → **Generate a new client secret** → copy the ID and secret → upload the logo. better-auth asks GitHub only for `read:user` and `user:email`, never repository access.

### 5.3 Cloudflare for `api.`

The tunnel itself is V1-PLAN §9 Stage 0. For sign-in:

- `cloudflared tunnel route dns <tunnel> api.app-mcp.com`, and the same for `api-staging`.
- Bot Fight Mode and Block AI bots off (LANDING-DEPLOY-PLAN §5.1 does it for the zone). Claude's and ChatGPT's backends fetch `/.well-known/*` and `/mcp`, and give up when challenged.
- One rate-limiting rule (Free allows one, with a 10-second window): hostname `api.app-mcp.com`, path starts with `/api/auth/`, per IP.
- No cache rules on `api.`.

## 6. Registry settings

### 6.1 Production

In the compose env file on the VPS, never in git:

```
GENUI_MODE=hosted
GENUI_PUBLIC_URL=https://api.app-mcp.com
GENUI_AUTH_SECRET=<openssl rand -hex 32>
GOOGLE_CLIENT_ID=<genui prod client ID>
GOOGLE_CLIENT_SECRET=<genui prod client secret>
GITHUB_CLIENT_ID=<genui app client ID>
GITHUB_CLIENT_SECRET=<genui app client secret>
```

- Leave unset: `GENUI_OIDC_*`, `GENUI_PASSWORD_LOGIN`, `GENUI_ALLOW_DCR`.
- `GENUI_PUBLIC_URL` exactly as above, with no path: tokens are bound to `<GENUI_PUBLIC_URL>/mcp`, and the Google and GitHub callback URLs are built from it.
- **`GENUI_AUTH_SECRET`:** generate it once and keep it in the password manager. better-auth encrypts its token-signing keys with it, so losing or changing it breaks every connector and session.

### 6.2 Staging

The same, with `GENUI_PUBLIC_URL=https://api-staging.app-mcp.com`, the `genui dev` Google client, the `genui staging` GitHub app and its own `GENUI_AUTH_SECRET`.

### 6.3 Your laptop

Claude and ChatGPT can't reach `localhost`, so give the laptop a fixed name once:

```bash
cloudflared tunnel login
```
```bash
cloudflared tunnel create genui-dev
```
```bash
cloudflared tunnel route dns genui-dev api-dev.app-mcp.com
```

Then, each session, run the tunnel:

```bash
cloudflared tunnel run --url http://localhost:4000 genui-dev
```

In the repo root's `.env.local`: `GENUI_MODE=hosted`, `GENUI_PUBLIC_URL=https://api-dev.app-mcp.com`, the `genui dev` Google client and the `genui dev` GitHub app. Start the registry:

```bash
pnpm --filter @genui/registry start
```

For quick work without a connector, skip the tunnel: `GENUI_PUBLIC_URL=http://localhost:4000` and `GENUI_PASSWORD_LOGIN=true`.

### 6.4 Checks

1. Discovery:
   ```bash
   curl -s https://api.app-mcp.com/.well-known/oauth-protected-resource/mcp
   ```
   `resource` is `https://api.app-mcp.com/mcp`.
   ```bash
   curl -s https://api.app-mcp.com/.well-known/oauth-authorization-server | jq .client_id_metadata_document_supported
   ```
   `true`.
2. **Claude:** Settings → Connectors → Add custom connector → `https://api.app-mcp.com/mcp` → Connect → Google → consent. Ask "show my genui components": the components view renders.
3. In a private window, connect again with GitHub on the same email: the same workspace (§8).
4. **ChatGPT:** add a custom connector (developer mode) with the same URL and sign in.

## 7. Web pages that need a login

- **Today:** only `/sign-in` and `/consent`, during a connector sign-in.
- **A dashboard later** uses the same better-auth, so the same people and workspaces. Easiest on `api.app-mcp.com` itself: same origin, and cookies just work. On its own subdomain (say `app.app-mcp.com`), it needs better-auth's cross-subdomain cookies for `app-mcp.com`, the dashboard in `trustedOrigins`, and CORS with credentials on `/api/auth/*`. That's a small code change, made when the dashboard exists.
- **The landing page** stays public.

## 8. Known behavior

- **One person, two providers.** Signing in with Google and with GitHub on the same email gives one person, when both providers report the email as verified. better-auth reads GitHub's own verified flag for that address. If it's unverified, the second provider's sign-in is refused and the person keeps using the first. Don't mark a provider as trusted to work around it: that would let an unverified GitHub email take over the Google account with that address.
- **Sign-ups are open.** In hosted mode, anyone with Google or GitHub who finds `api.app-mcp.com` gets a workspace. Fine while nobody knows the URL; add the gate (§9.2) before telling anyone outside the team.
- **Roles.** Everyone is admin of their own workspace. Invites, matched by verified email, add people to other workspaces.

## 9. Code follow-ups

None block the first sign-in.

1. **`/privacy` and `/terms` on the landing site.** Google's consent screen links to them. The text needs your input; the DPA (V1-PLAN §9) can reuse it.
2. **Sign-up gate:** `GENUI_ALLOWED_EMAILS` (addresses and `@domain` entries), checked before better-auth creates a user, until quotas are in (V1-PLAN §9 Stage 0, step 6). Existing members and invited emails always get in.

## 10. Where each secret goes

| Value | From | To |
|---|---|---|
| `genui prod` Google client ID and secret | Google Cloud → Clients | Prod env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `genui dev` Google client ID and secret | Google Cloud → Clients | Staging env and `.env.local` |
| `genui` GitHub app ID and secret | GitHub → OAuth Apps | Prod env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| `genui staging` GitHub app ID and secret | GitHub → OAuth Apps | Staging env |
| `genui dev` GitHub app ID and secret | GitHub → OAuth Apps | `.env.local` |
| `GENUI_AUTH_SECRET` (one per environment) | `openssl rand -hex 32` | That environment's env file, and the password manager |
