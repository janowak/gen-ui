# Landing deploy plan

Put `apps/site` live at `https://app-mcp.com` on Cloudflare: deployed from a laptop with one command, `pnpm deploy:site`. CI deploys can come later. The domain is registered through Cloudflare, so the zone already exists.

**Status (2026-10-26)**
- Live since 2026-10-25: `pnpm deploy:site` deployed the `app-mcp-site` Worker and created the `app-mcp.com` custom domain. §4 is done.
- Next, in the dashboard (§5): Always Use HTTPS (plain http still answers 200), the www record and redirect, and Email Routing (mail to `hello@` bounces until then).
- Changes V1-PLAN §9: the landing page and playground run on Workers static assets, not Pages (§2).

---

## 1. What we deploy

- A static page: `index.html`, 34 KB of CSS, 3 KB of JS and the Geist fonts. `pnpm --filter @app-mcp/site build` writes 236 KB to `apps/site/dist`.
- No backend, no environment variables. The only workspace dependency is `@app-mcp/ui/styles.css`, read from source, so nothing else has to be built first.
- **`master` still has the beta/stable copy.** The environments copy is on the `environments` branch. Deploy from that branch, or merge it first.

## 2. Hosting: Workers static assets, deployed from a laptop

| | Workers static assets (chosen) | Pages |
|---|---|---|
| Status | Where Cloudflare adds new features; recommended for new projects | Supported, gets no new features |
| Static requests | Free, unlimited | Free, unlimited |
| Deploys | `wrangler deploy` (CI later) | Git builds built in, or `wrangler` |
| Later: early-access endpoint, edge data plane (V1-PLAN §9 Stage 2) | Same Worker, same config | Needs a separate Worker anyway |

- **Assets-only Worker:** no `main`, so no script runs and nothing counts against Worker limits. A script is added only when the early-access form needs one (§7).
- **A local deploy for now:** `pnpm deploy:site` builds the site and runs `wrangler deploy` with the `wrangler` version from the lockfile, as whoever ran `wrangler login`. It deploys the working tree, so deploy from a clean checkout. CI (GitHub Actions or Workers Builds) can run the same script later.
- **Cost:** $0. The domain renews at cost through Cloudflare Registrar.

## 3. Addresses

| Address | Serves |
|---|---|
| `app-mcp.com` | The landing page (Worker custom domain) |
| `www.app-mcp.com` | 301 to `https://app-mcp.com`, path and query kept |
| `play.`, `registry.`, `mcp.`, `demo.`, `assets.` | Reserved by V1-PLAN §9 and CDN-BUNDLES-PLAN. Not created now. |
| `hello@app-mcp.com` | Early access, forwarded by Email Routing |

## 4. Repo changes

1. **`apps/site/wrangler.jsonc`**, plus `wrangler` as a dev dependency of the site so local and CI deploys use the same version:
   ```jsonc
   {
     "name": "app-mcp-site",
     "account_id": "9341ca52ab56b808dfd9a4a673fce52c",
     "compatibility_date": "2026-10-01",
     "assets": { "directory": "./dist", "not_found_handling": "404-page" },
     "routes": [{ "pattern": "app-mcp.com", "custom_domain": true }],
     "workers_dev": false,
     "preview_urls": true
   }
   ```
   `workers_dev: false` keeps production off `workers.dev`; preview versions (`wrangler versions upload`) keep their URLs.
2. **Node 24**, the version the image pins (V1-PLAN §9), for local deploys and CI later. Not a `.node-version` file: the global gitignore here excludes it.
3. **`apps/site/404.html`** as a second Vite input, so it shares the CSS. `not_found_handling: "404-page"` serves it with a 404 status. Not the SPA fallback: that answers every path with the home page and a 200.
4. **`apps/site/public/_headers`:**
   ```
   /assets/*
     Cache-Control: public, max-age=31536000, immutable

   /*
     X-Content-Type-Options: nosniff
     Referrer-Policy: strict-origin-when-cross-origin
     Content-Security-Policy: frame-ancestors 'none'
     Permissions-Policy: camera=(), microphone=(), geolocation=()
   ```
   HTML keeps the default (revalidate by ETag), so a deploy shows on the next load. No script CSP: the page takes no input and loads no third-party script besides analytics, and the inline theme script would need a hash kept in sync by hand.
5. **`index.html` head:** canonical `https://app-mcp.com/`, Open Graph and Twitter card tags, and `public/og.png` (1200×630). Without them a link shared in Slack, X or LinkedIn previews as a bare URL.
6. **`public/robots.txt`** (allow all, link the sitemap) and **`public/sitemap.xml`** (one URL).
7. **Early access:** replace the empty `mailto:` (the TODO in `index.html`) with `mailto:hello@app-mcp.com?subject=app-mcp%20early%20access`, and print the address next to the button for visitors without a mail client.
8. **Web Analytics:** Cloudflare's beacon snippet in `index.html`, with the site's token (§5.6). No cookies, so no consent banner.
9. **Deploy script:** `pnpm deploy:site` at the repo root runs the site's `deploy` script: build, then `wrangler deploy --tag <commit>`, so the Worker's Deployments tab shows which commit is live. `wrangler.jsonc` names the account (`9341ca52…`), which must be the one holding `app-mcp.com`. Inside `apps/site`, use `pnpm run deploy`: plain `pnpm deploy` is a pnpm command.

## 5. Cloudflare setup (dashboard, once)

1. **Zone settings** for `app-mcp.com`. These also prepare the zone for the MCP hostnames.
   - SSL/TLS: Full (strict), Always Use HTTPS, minimum TLS 1.2.
   - Bot Fight Mode off (V1-PLAN §9 Stage 0).
   - Block AI bots off, managed robots.txt off. New zones can start with AI crawlers blocked. We want Claude and ChatGPT search to read the page, and nothing on this zone should challenge AI backends once the MCP hostnames exist.
   - HSTS later, once `registry.`, `mcp.` and `demo.` serve HTTPS: `includeSubDomains`, no preload yet.
2. **Email Routing:** enable it (it adds the MX and SPF records), forward `hello@` to your inbox and verify that inbox. Add a `_dmarc` TXT record: `v=DMARC1; p=none`. Replies go out from your own address until something can send as `hello@` (out of scope).
3. **Sign in wrangler:** `pnpm --filter @app-mcp/site exec wrangler login`, as a member of the account in `wrangler.jsonc`. `wrangler whoami` shows the account.
4. **Custom domain:** the first production deploy creates it from `routes`, with its DNS record and certificate. Check it under the Worker's Settings → Domains & Routes.
5. **www:** a proxied `AAAA www 100::` record and a Redirect Rule from the "Redirect from WWW to root" template (301, query kept).
6. **Web Analytics:** add `app-mcp.com` as a site and copy its token into the snippet (§4.8).

## 6. First deploy and checks

1. From a clean checkout of the branch to ship, run `pnpm deploy:site`. The first run creates the `app-mcp-site` Worker and the `app-mcp.com` custom domain.
2. If it fails on the custom domain, the zone is in another account: fix `account_id` in `wrangler.jsonc`, or `wrangler login` to that account.
3. Check:
   - `curl -sI https://app-mcp.com/`: 200, with the `_headers` headers.
   - `curl -sI https://app-mcp.com/assets/<css file>`: `cache-control: public, max-age=31536000, immutable`.
   - `curl -sI 'https://www.app-mcp.com/x?y=1'`: 301 to `https://app-mcp.com/x?y=1`.
   - `curl -sI http://app-mcp.com/`: 301 to HTTPS.
   - `curl -sI https://app-mcp.com/nope`: 404, and the browser shows the 404 page.
   - `app-mcp-site.<account>.workers.dev` doesn't answer.
   - Mail to `hello@app-mcp.com` arrives.
   - Pasting the URL in Slack shows the title, description and image.
   - Lighthouse on mobile is clean; Web Analytics records the visit.
4. **Rollback:** the Worker's Deployments tab → roll back, or `wrangler rollback`. Assets belong to the version, so the old page comes back whole.

## 7. After launch

- **Early-access form instead of `mailto:`:** the form posts to `/api/early-access` on the same Worker (add `main`, and `run_worker_first: ["/api/*"]` under `assets`). Turnstile against spam, rows in D1, and a notification through Email Routing's `send_email` binding, which can send to verified addresses, so it can notify us. Still free.
- **Playground at `play.app-mcp.com`:** the same recipe, with its own Worker and `wrangler.jsonc`.
- **Docs:** `/docs` on the landing Worker or a `docs.` host. Decide when there are docs.

## 8. Open question

- **Name.** The page says app-mcp; the domain says app-mcp. The title, Open Graph tags, email subject and footer follow whichever name wins. The deploy doesn't depend on it.
