# Auth0 plan

People sign in to genui cloud with Google or GitHub through Auth0. The registry, both MCPs and the API live at `https://api.app-mcp.com`; Auth0's login lives at `https://auth.app-mcp.com`.

**Status (2026-10-24)**
- Proposed. Launch needs no code change: the registry already takes any OIDC provider through `GENUI_OIDC_*`. The work is dashboard setup (§5) and settings (§6).
- Changes V1-PLAN §5 and §9 (Hosting) and LANDING-DEPLOY-PLAN §3: one `api.app-mcp.com` hostname instead of `registry.` and `mcp.`, `auth.` for Auth0, and Auth0 instead of separate GitHub and Google OAuth apps in the cloud. Those files aren't edited yet.

---

## 1. Decision: Auth0 signs people in, better-auth stays the MCP's authorization server

```
Claude / ChatGPT ──OAuth 2.1, CIMD──▶ better-auth on api.app-mcp.com ──OIDC──▶ Auth0 on auth.app-mcp.com ──▶ Google, GitHub
                 ◀── access token bound to https://api.app-mcp.com/mcp, with the workspace claim
```

- **better-auth keeps its job:** Client ID Metadata Documents for any MCP client, the consent page, tokens bound to `/mcp`, the workspace claim. Self-host runs the same code.
- **Auth0 is one upstream OIDC provider** (`sso` in `auth.ts`). It sees logins, never MCP traffic or tokens.

**Not Auth0 as the MCP's authorization server** ("Auth for MCP", GA May 2026):
- An admin registers each CIMD client by importing its metadata URL. better-auth accepts any client's document on first use, so Claude, ChatGPT, Cursor and VS Code just work.
- Its CIMD registration rejects ChatGPT's metadata document (forum thread, Sept–Oct 2026, unresolved). The suggested workaround is DCR, which we keep off.
- Self-host keeps better-auth either way, so the cloud would run a second auth path, with the workspace claim in an Auth0 Action.
- Revisit if Auth0 accepts CIMD clients automatically and we need Auth0-issued tokens for something else.

**Auth0 rather than direct Google and GitHub apps** (the registry supports those too):
- Customers' own IdPs (Okta, Entra, SAML) become Auth0 connections later, with no deploy. Enterprise connections need a paid Auth0 plan.
- A Post-Login Action gates sign-ups during the private beta, without code (§5.5).
- Login logs, attack protection, and a login page on our own domain.
- Little lock-in. People are better-auth users; Auth0's user id is only the linked account. Moving to direct Google and GitHub later relinks people by verified email.

**Cost:** $0. Auth0 Free covers 25,000 monthly active users and one custom domain (a card on file is required for the domain). Google and GitHub charge nothing.

## 2. Addresses

| Address | Serves | Cloudflare DNS |
|---|---|---|
| `api.app-mcp.com` | The registry container: management MCP `/mcp`, end-user MCP `/w/<workspace>/mcp` and `/w/<workspace>/<environment>/mcp`, `/v1`, `/api/auth/*`, `/sign-in`, `/consent`, `/.well-known/*` | Tunnel, proxied |
| `api-staging.app-mcp.com` | Staging's compose project | Tunnel, proxied |
| `api-dev.app-mcp.com` | Your laptop, through a named tunnel (§6.3) | Tunnel, proxied |
| `auth.app-mcp.com` | Auth0: its login page, `/authorize`, `/oauth/token`, `/login/callback` | CNAME to Auth0, **DNS only** |
| `app-mcp.com` | Landing, plus `/privacy` and `/terms` for Google's consent screen | [LANDING-DEPLOY-PLAN](LANDING-DEPLOY-PLAN.md) |

- **`api-staging`, not `api.staging`:** Cloudflare's free certificate covers one level of subdomains.
- **One hostname for both MCPs.** Connector URLs still never change when the end-user MCP moves: a tunnel ingress rule (own container) or a Worker route on `api.app-mcp.com/w/*` (edge, V1-PLAN §9 Stage 2) takes those paths, and the rest keeps going to the registry. `GENUI_HOSTED_URL` isn't needed: hosted URLs share `GENUI_PUBLIC_URL`.
- **`auth` stays DNS only, permanently.** Behind Cloudflare's proxy, Auth0 can't issue its certificate and the domain stays "pending". Certificate renewals need the record too. Don't turn on "Flatten all CNAMEs" for the zone.

## 3. Sign-in, step by step

1. Claude calls `https://api.app-mcp.com/mcp` and gets a 401 that points to `/.well-known/oauth-protected-resource/mcp`.
2. Claude identifies itself with its Client ID Metadata Document and opens `/api/auth/oauth2/authorize`.
3. better-auth shows `/sign-in`: **Continue with Google or GitHub**.
4. The browser goes to `auth.app-mcp.com`. Auth0's page offers Google and GitHub.
5. Google or GitHub returns to `auth.app-mcp.com/login/callback`, then Auth0 returns to `api.app-mcp.com/api/auth/callback/sso`. better-auth checks the ID token and finds the person by Auth0 user id, then by verified email. In hosted mode, a first sign-in creates a personal workspace.
6. `/consent`, then back to Claude with a token bound to `https://api.app-mcp.com/mcp`.

## 4. Before you start

- **The name** (LANDING-DEPLOY-PLAN §8). It shows on Google's consent screen, GitHub's authorize page and Auth0's login page, and Google's brand verification checks that `app-mcp.com` shows the same name. This plan writes `genui`; use the winner everywhere.
- **Landing live** with `/privacy` and `/terms` (§8.1). Google's consent screen links to them.
- **A card** for Auth0's custom domain.
- **No VPS needed yet:** §6.3 runs the whole flow from your laptop.

## 5. Setup, in order

### 5.1 Auth0 tenant

1. Sign up at auth0.com with an account you'll keep for the company, with 2FA on. Create a tenant:
   - Name `app-mcp`. It can't be renamed and becomes `app-mcp.eu.auth0.com`.
   - Region **EU**, like the VPS.
   - Environment tag **Production**.
2. **Settings → General:** friendly name `genui`, logo URL, support email `hello@app-mcp.com`, support URL `https://app-mcp.com`.
3. **Settings → Advanced:** leave Dynamic Client Registration and Client ID Metadata Document Registration **off**. better-auth registers MCP clients, not Auth0.
4. Add the card under Billing.

### 5.2 Custom domain `auth.app-mcp.com`

Do this before Google and GitHub, so their callback URL is final. GitHub accepts only one.

1. Auth0 → **Branding → Custom Domains** → add `auth.app-mcp.com`, certificate **Auth0-managed**. Auth0 shows a CNAME target.
2. Cloudflare → **DNS → Records** → CNAME `auth` → that target, proxy status **DNS only** (grey cloud).
3. Auth0 → **Verify**. Then:
   ```bash
   curl -s https://auth.app-mcp.com/.well-known/openid-configuration | jq -r .issuer
   ```
   Expect `https://auth.app-mcp.com/`.

### 5.3 Google

1. [console.cloud.google.com](https://console.cloud.google.com) → new project `app-mcp-auth`.
2. [Google Search Console](https://search.google.com/search-console) → add a **Domain** property `app-mcp.com` → copy the TXT record → add it in Cloudflare DNS → Verify. Google requires it for the authorized domain and brand verification.
3. **Google Auth Platform → Branding:**
   - App name `genui`, user support email (your Google account, or a Google Group you manage).
   - Home page `https://app-mcp.com`, privacy policy `https://app-mcp.com/privacy`, terms `https://app-mcp.com/terms`.
   - Authorized domain `app-mcp.com`; developer contact email.
   - A logo is optional and sends the app to brand review (a few business days).
4. **Audience:** External → **Publish app**. In Testing, only listed test users can sign in. `openid`, `email` and `profile` are non-sensitive scopes, so there's no security review.
5. **Data access:** add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
6. **Clients → Create client** → Web application, name `Auth0`. Authorized redirect URIs:
   - `https://auth.app-mcp.com/login/callback`
   - `https://app-mcp.eu.auth0.com/login/callback`

   No JavaScript origins.
7. Copy the client ID and secret into your password manager. The secret is shown once.

### 5.4 GitHub

1. Under the GitHub organization that will own the product (a personal account works, and the app can be transferred later): **Settings → Developer settings → OAuth Apps → New OAuth App**. An OAuth App, not a GitHub App.
2. Application name `genui`; homepage `https://app-mcp.com`; authorization callback URL `https://auth.app-mcp.com/login/callback`. Device flow off.
3. **Generate a new client secret.** Copy the client ID and secret. Upload the logo.

### 5.5 Auth0 connections, applications and the beta gate

1. **Authentication → Social → Google / Gmail:** paste Google's client ID and secret. Attributes: basic profile and email. Never Auth0's dev keys: they're for testing and show Auth0's name.
2. **Authentication → Social → GitHub:** paste GitHub's client ID and secret. Attributes: **Email address** (`user:email`). No other permissions; we never touch repositories.
3. **Authentication → Database → Username-Password-Authentication:** turn it off for every application, or delete it. Otherwise Auth0's page offers email and password sign-up.
4. **Applications → Create Application** → `genui API`, type **Regular Web Application**:
   - Allowed Callback URLs: `https://api.app-mcp.com/api/auth/callback/sso`
   - Allowed Logout URLs, Allowed Web Origins, Allowed Origins (CORS): empty.
   - Credentials → Authentication Method: **Client Secret (Post)**, better-auth's default.
   - Advanced → Grant Types: **Authorization Code** only.
   - Connections tab: `google-oauth2` and `github` on, Username-Password off.
   - Copy the client ID and secret.
5. **A second application,** `genui API (dev)`, with the same settings and connections. Allowed Callback URLs:
   - `https://api-staging.app-mcp.com/api/auth/callback/sso`
   - `https://api-dev.app-mcp.com/api/auth/callback/sso`
   - `http://localhost:4000/api/auth/callback/sso`

   Its own secret, so a leaked dev secret can't sign anyone in to prod.
6. **Branding → Universal Login:** logo, primary color and background from the landing page.
7. **Actions → Library → Create Action → Build from scratch:** name `Private beta allowlist`, trigger **Login / Post Login**. Add the secret `ALLOWED_EMAILS` (comma-separated), then:
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     const allowed = (event.secrets.ALLOWED_EMAILS ?? "").toLowerCase().split(",").map((e) => e.trim());
     const email = event.user.email?.toLowerCase();
     if (!email || !event.user.email_verified || !allowed.includes(email)) {
       api.access.deny("genui is invite-only for now. Write to hello@app-mcp.com for access.");
     }
   };
   ```
   Deploy it, then **Actions → Triggers → post-login**: drag it into the flow → Apply. Remove it when sign-ups open (after the quotas in V1-PLAN §9 Stage 0, step 6).

### 5.6 Cloudflare for `api.app-mcp.com`

The tunnel itself is V1-PLAN §9 Stage 0. For sign-in:

- `cloudflared tunnel route dns <tunnel> api.app-mcp.com`, and the same for `api-staging`.
- Bot Fight Mode and Block AI bots off (LANDING-DEPLOY-PLAN §5.1 does this for the zone). Claude's and ChatGPT's backends fetch `/.well-known/*` and `/mcp` and give up when challenged.
- One rate-limiting rule (Free allows one, with a 10-second window): hostname `api.app-mcp.com`, path starts with `/api/auth/`, per IP.
- No cache rules on `api.`.

## 6. Registry settings

### 6.1 Production

In the compose env file on the VPS, never in git:

```
GENUI_MODE=hosted
GENUI_PUBLIC_URL=https://api.app-mcp.com
GENUI_AUTH_SECRET=<openssl rand -hex 32>
GENUI_OIDC_ISSUER=https://auth.app-mcp.com
GENUI_OIDC_CLIENT_ID=<genui API client ID>
GENUI_OIDC_CLIENT_SECRET=<genui API client secret>
GENUI_OIDC_NAME=Google or GitHub
```

- Leave unset: `GITHUB_*` and `GOOGLE_*` (Auth0 has them), `GENUI_PASSWORD_LOGIN`, `GENUI_ALLOW_DCR`.
- `GENUI_PUBLIC_URL` exactly as above, with no path: tokens are bound to `<GENUI_PUBLIC_URL>/mcp`, and Auth0's callback URL is built from it.
- `GENUI_OIDC_NAME` is the button label: "Continue with Google or GitHub".
- **`GENUI_AUTH_SECRET`:** generate it once and keep it in the password manager. better-auth encrypts its token-signing keys with it, so losing or changing it breaks every connector and session.

### 6.2 Staging

The same, with `GENUI_PUBLIC_URL=https://api-staging.app-mcp.com`, the `genui API (dev)` credentials and its own `GENUI_AUTH_SECRET`.

### 6.3 Your laptop, end to end

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

In the repo root's `.env.local`: `GENUI_MODE=hosted`, `GENUI_PUBLIC_URL=https://api-dev.app-mcp.com` and the `genui API (dev)` values. Start the registry:

```bash
pnpm --filter @genui/registry start
```

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
3. In a private window, connect again with GitHub on the same email. Same workspace if GitHub reports the email as verified; otherwise see §7.
4. **ChatGPT:** add a custom connector (developer mode) with the same URL and sign in.
5. An email that isn't on the allowlist is refused. Note what that person sees (§8.3).
6. Auth0 → **Monitoring → Logs** shows the successful logins and the refusal.

## 7. Known behavior

- **One person, two providers.** Each Google or GitHub identity is its own Auth0 user (and counts as its own active user). better-auth joins them into one person only when both emails are verified. GitHub's can arrive unverified, because Auth0 copies GitHub's flag. Then the second provider's sign-in fails, and the person keeps using the first. Don't mark `sso` as trusted in better-auth to work around it: that would let an unverified GitHub email take over the Google account with that address.
- **Switching accounts.** Auth0 remembers the last login on `auth.app-mcp.com`, so a second connector sign-in can skip its page. To sign in as someone else, use a private window.
- **Roles.** In hosted mode everyone gets a personal workspace as admin. Invites, matched by verified email, add people to other workspaces.

## 8. Code follow-ups

None block the launch.

1. **`/privacy` and `/terms` on the landing site.** Google's consent screen links to them. The text needs your input; the DPA (V1-PLAN §9) can reuse it.
2. **Two buttons instead of one:** "Continue with Google" and "Continue with GitHub", each passing Auth0's `connection` parameter (`google-oauth2`, `github`), which skips Auth0's own page. A small change in `auth.ts` and `web/src/sign-in.ts`.
3. **Say why a sign-in was refused** (the beta allowlist), if §6.4 step 5 shows a bare error page.
4. **README:** an Auth0 example under "Company IdP via OIDC". Self-hosters can use the same setup.

## 9. Where each secret goes

| Value | From | To |
|---|---|---|
| Google client ID and secret | Google Cloud → Clients | Auth0 → Social → Google |
| GitHub client ID and secret | GitHub → OAuth App | Auth0 → Social → GitHub |
| `genui API` client ID and secret | Auth0 → Applications | Prod env: `GENUI_OIDC_CLIENT_ID`, `GENUI_OIDC_CLIENT_SECRET` |
| `genui API (dev)` client ID and secret | Auth0 → Applications | Staging env and `.env.local` |
| `GENUI_AUTH_SECRET` (one per environment) | `openssl rand -hex 32` | That environment's env file, and the password manager |
| `ALLOWED_EMAILS` | You | Auth0 → the Action's secrets |
