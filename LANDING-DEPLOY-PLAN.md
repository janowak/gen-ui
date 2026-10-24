# Landing deploy plan

Put `apps/site` live at `https://app-mcp.com` on Cloudflare: production deploys from `master` on every push, and each PR gets a preview URL. The domain is registered through Cloudflare, so the zone already exists.

**Status (2026-10-24)**
- §4 is done (uncommitted): `wrangler deploy --dry-run` passes, and `wrangler dev` (the `site-worker` launch entry) serves the headers, caching and 404 page as planned. Next: the one-time dashboard setup (§5).
- Changes V1-PLAN §9: the landing page and playground run on Workers static assets, not Pages (§2).

---

## 1. What we deploy

- A static page: `index.html`, 34 KB of CSS, 3 KB of JS and the Geist fonts. `pnpm --filter @genui/site build` writes 236 KB to `apps/site/dist`.
- No backend, no environment variables. The only workspace dependency is `@genui/ui/styles.css`, read from source, so nothing else has to be built first.
- **`master` still has the beta/stable copy.** The environments copy is on the `environments` branch (645d590). Merge that branch before the first production deploy.

## 2. Hosting: Workers static assets, built by Workers Builds

| | Workers static assets (chosen) | Pages |
|---|---|---|
| Status | Where Cloudflare adds new features; recommended for new projects | Supported, gets no new features |
| Static requests | Free, unlimited | Free, unlimited |
| Builds from Git, PR previews | Workers Builds | Built in |
| Later: early-access endpoint, edge data plane (V1-PLAN §9 Stage 2) | Same Worker, same config | Needs a separate Worker anyway |

- **Assets-only Worker:** no `main`, so no script runs and nothing counts against Worker limits. A script is added only when the early-access form needs one (§7).
- **Workers Builds, not GitHub Actions:** Cloudflare's GitHub app builds on push, posts a check and a preview URL on each PR, and needs no API token in GitHub secrets. The VPS keeps its own Actions pipeline (V1-PLAN §9 Stage 0).
- **Cost:** $0. The domain renews at cost through Cloudflare Registrar.

## 3. Addresses

| Address | Serves |
|---|---|
| `app-mcp.com` | The landing page (Worker custom domain) |
| `www.app-mcp.com` | 301 to `https://app-mcp.com`, path and query kept |
| `<version>-genui-site.<account>.workers.dev` | PR previews |
| `play.`, `registry.`, `mcp.`, `demo.`, `assets.` | Reserved by V1-PLAN §9 and CDN-BUNDLES-PLAN. Not created now. |
| `hello@app-mcp.com` | Early access, forwarded by Email Routing |

## 4. Repo changes

1. **`apps/site/wrangler.jsonc`**, plus `wrangler` as a dev dependency of the site so local and CI deploys use the same version:
   ```jsonc
   {
     "name": "genui-site",
     "compatibility_date": "2026-10-01",
     "assets": { "directory": "./dist", "not_found_handling": "404-page" },
     "routes": [{ "pattern": "app-mcp.com", "custom_domain": true }],
     "workers_dev": false,
     "preview_urls": true
   }
   ```
   `workers_dev: false` keeps production off `workers.dev`; PR previews keep their URLs.
2. **Node 24**, the version the image pins (V1-PLAN §9), set as the `NODE_VERSION` build variable (§5.3). Not a `.node-version` file: the global gitignore here excludes it, so the build would never see it.
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
7. **Early access:** replace the empty `mailto:` (the TODO in `index.html`) with `mailto:hello@app-mcp.com?subject=genui%20early%20access`, and print the address next to the button for visitors without a mail client.
8. **Web Analytics:** Cloudflare's beacon snippet in `index.html`, with the site's token (§5.6). No cookies, so no consent banner.

## 5. Cloudflare setup (dashboard, once)

1. **Zone settings** for `app-mcp.com`. These also prepare the zone for the MCP hostnames.
   - SSL/TLS: Full (strict), Always Use HTTPS, minimum TLS 1.2.
   - Bot Fight Mode off (V1-PLAN §9 Stage 0).
   - Block AI bots off, managed robots.txt off. New zones can start with AI crawlers blocked. We want Claude and ChatGPT search to read the page, and nothing on this zone should challenge AI backends once the MCP hostnames exist.
   - HSTS later, once `registry.`, `mcp.` and `demo.` serve HTTPS: `includeSubDomains`, no preload yet.
2. **Email Routing:** enable it (it adds the MX and SPF records), forward `hello@` to your inbox and verify that inbox. Add a `_dmarc` TXT record: `v=DMARC1; p=none`. Replies go out from your own address until something can send as `hello@` (out of scope).
3. **Connect the repo:** Workers & Pages → Create → Import a repository → `janowak/gen-ui`.
   - Worker name: `genui-site`. It must match `wrangler.jsonc` or the build fails.
   - Root directory: `apps/site`.
   - Build command: `pnpm build`. If the install step misses the workspace lockfile, use `pnpm install --frozen-lockfile && pnpm build`.
   - Deploy command: `npx wrangler deploy`. Non-production branches: builds on, `npx wrangler versions upload`.
   - Production branch: `master`.
   - Build watch paths: `apps/site/*`, `packages/ui/src/styles.css`, `pnpm-lock.yaml`, so other commits don't rebuild the site.
   - Build variables: `NODE_VERSION=24`. pnpm comes from `packageManager` (9.14.2); set `PNPM_VERSION` if the build log shows a different one.
4. **Custom domain:** the first production deploy creates it from `routes`, with its DNS record and certificate. Check it under the Worker's Settings → Domains & Routes.
5. **www:** a proxied `AAAA www 100::` record and a Redirect Rule from the "Redirect from WWW to root" template (301, query kept).
6. **Web Analytics:** add `app-mcp.com` as a site and copy its token into the snippet (§4.8).

## 6. First deploy and checks

1. Open a PR with §4. Its check posts a preview URL: the page renders, and the theme toggle and hero demo work.
2. Merge `environments`, then the §4 PR, into `master`. That deploys production.
3. Check:
   - `curl -sI https://app-mcp.com/`: 200, with the `_headers` headers.
   - `curl -sI https://app-mcp.com/assets/<css file>`: `cache-control: public, max-age=31536000, immutable`.
   - `curl -sI 'https://www.app-mcp.com/x?y=1'`: 301 to `https://app-mcp.com/x?y=1`.
   - `curl -sI http://app-mcp.com/`: 301 to HTTPS.
   - `curl -sI https://app-mcp.com/nope`: 404, and the browser shows the 404 page.
   - `genui-site.<account>.workers.dev` doesn't answer.
   - Mail to `hello@app-mcp.com` arrives.
   - Pasting the URL in Slack shows the title, description and image.
   - Lighthouse on mobile is clean; Web Analytics records the visit.
4. **Rollback:** the Worker's Deployments tab → roll back, or `wrangler rollback`. Assets belong to the version, so the old page comes back whole.

## 7. After launch

- **Early-access form instead of `mailto:`:** the form posts to `/api/early-access` on the same Worker (add `main`, and `run_worker_first: ["/api/*"]` under `assets`). Turnstile against spam, rows in D1, and a notification through Email Routing's `send_email` binding, which can send to verified addresses, so it can notify us. Still free.
- **Playground at `play.app-mcp.com`:** the same recipe, with its own Worker and `wrangler.jsonc`.
- **Docs:** `/docs` on the landing Worker or a `docs.` host. Decide when there are docs.

## 8. Open question

- **Name.** The page says genui; the domain says app-mcp. The title, Open Graph tags, email subject and footer follow whichever name wins. The deploy doesn't depend on it.
