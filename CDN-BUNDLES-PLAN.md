# CDN bundles plan

Serve each view as a small `ui://` page that loads genui's content-hashed JS and CSS from a static asset domain, instead of one single-file HTML with everything inlined. The server keeps serving the page; the code comes from the bucket.

**Status (2026-10-23)**
- Proposed. Starts after the M0 spike confirms the host checks in §6.
- A browser-side optimization, not a server-load one: genui sends each bundle to a company's server about once per version.

---

## 1. Why

Every view inlines its own copy of everything (measured on today's build):

| View | Single file | gzip |
|---|---|---|
| form | 708 KB (627 KB JS, 80 KB CSS) | 200 KB |
| chart | 772 KB | 211 KB |
| custom `rating` example | 242 KB | 63 KB |

A test build with code splitting shows most of that is shared:

| Shared piece | gzip | Used by |
|---|---|---|
| Runtime (Preact, ext-apps, zod, MCP JSON-RPC) | 84 KB | every view |
| CSS (Tailwind, shadcn tokens) | 13 KB | every view |
| Recharts | 111 KB | chart, theme |
| Date picker and date-fns | 87 KB | form |

View-specific entry files are 1–13 KB.

**Where the bytes go today:** genui → SDK once per process per version (negligible for the VPS), then company server → host → browser on every host fetch. The browser parses the full bundle on every render and can't reuse compiled code across renders, because the scripts are inline.

---

## 2. Design

- **The page.** The `ui://genui/<view>/<hash>` resource becomes ~1 KB of `<script type="module">` and `<link rel="modulepreload">` / `<link rel="stylesheet">` tags with absolute URLs and `integrity` hashes. The URI hash covers the page, so it pins exact asset hashes. Old messages keep rendering the code they were made with.
- **Asset domain.** `assets.<domain>`: an R2 bucket on a Cloudflare custom domain.
  - Paths are content-hashed (`/<name>-<hash>.js`).
  - Headers: `Cache-Control: public, max-age=31536000, immutable` and `Access-Control-Allow-Origin: *`.
  - Assets are never deleted (same rule as bundles today).
- **CSP.** `_meta.ui.csp.resourceDomains: ["https://assets.<domain>"]`, set on the resource `contents[]` (not on `registerAppResource`'s config). It maps to `script-src`, `style-src`, `img-src` and `font-src`.
- **Only genui's code on the asset domain:** the runtime and the built-in views (form, chart, manager, theme, recipes).
  - Custom components keep their own code inline in their page and import the shared runtime from the asset domain.
  - Tenant code never shares an allowlisted origin with another tenant's views.
- **Switch.** `GENUI_ASSETS_URL`. Unset means today's single-file bundles.
  - Self-host defaults to inline, so browsers never need to reach a company's registry.
  - Cloud turns it on once §6 passes for Claude and ChatGPT.
- **Component contract.** The runtime is pinned by hash in each component's page. A component built against an older `@genui/kit` keeps loading the runtime it was built with.

---

## 3. Expected gains

| | Today | First load in a browser | After that |
|---|---|---|---|
| form | ~700 KB per host fetch | ~1 KB page + ~200 KB gz from the CDN | ~1 KB |
| chart after a form | ~770 KB | ~1 KB + ~113 KB gz (only the chart code is new) | ~1 KB |
| custom component | ships its own runtime | its own code only (likely tens of KB, not measured) | ~1 KB |

Also:
- Browsers can cache compiled code for scripts loaded from a URL.
- Rarely used dependencies (the date picker) can load only when a form needs them.
- Bundle storage leaves SQLite.

---

## 4. Requirements

- **SRI on every script and preload.** Without it, whoever controls the CDN could change the code behind an old message. Avoid dynamic `import()` in views, or cover those chunks with import-map `integrity`.
- **CORS on the asset domain.** Module scripts are always fetched with CORS. The view's sandbox origin may be opaque (`null`), so allow `*`.
- **Absolute URLs.** The page has no base URL; no `baseUriDomains` needed.
- **Dev.** `genui dev` and the playground serve assets from localhost and declare it in `resourceDomains`.

---

## 5. Costs and risks

| Risk | Mitigation |
|---|---|
| Browsers start talking to genui (today only the company's server does). Corporate firewalls can block an unknown CDN, and the view renders blank. | Inline fallback via `GENUI_ASSETS_URL`. A per-workspace setting if a customer needs it. |
| We and Cloudflare see end users' IPs on first load per version. Weakens the "no data proxy" story slightly. | Immutable caching keeps it to the first load. Add it to the DPA and the subprocessor list. |
| A host approves fewer domains than declared, or doesn't support `resourceDomains`. | Check `hostCapabilities.sandbox.csp` in the M0 spike. Keep the single-file build. |
| The first load takes one more round trip. | Roughly a wash with sending ~700 KB through the host. Faster on every load after. |
| Supply-chain review ("loads vendor scripts at runtime"). | SRI, content hashes, assets never change, and a written answer in the security docs. |

---

## 6. M0 checks (before building)

- Do Claude and ChatGPT allow scripts, module preloads and stylesheets from a declared `resourceDomains` origin?
- Does SRI work inside each host's sandbox (srcdoc or blob documents, opaque origin)?
- Do hosts send the resource HTML again on every render, or cache it on the client? If they cache it, the gain shrinks to code caching and the shared runtime.
- What does `hostCapabilities.sandbox.csp` report?

---

## 7. Steps

1. **Build.** A second output mode in `@genui/ui`: the small page plus hashed assets plus SRI, next to today's single-file build.
2. **Release.** CI uploads assets to R2 before the registry points any `ui://` URI at them.
3. **Registry.** With `GENUI_ASSETS_URL` set, serve the small page and its CSP; otherwise inline. Same switch in the registry MCP's management views.
4. **Kit.** `@genui/kit`'s Vite plugin treats the runtime as external, imports it from the asset domain, and records the runtime hash in the manifest. Publish checks validate it.
5. **Lazy chunks.** Date picker (and later other heavy field types) load only when used.
6. **Docs.** Self-host stays inline. Cloud DPA and security notes cover the asset domain.

---

## 8. Out of scope

- Tenant code on the CDN. If wanted later: per-workspace origins (`<workspace>.assets.<domain>`) plus SRI.
- Choosing inline or CDN per host from the host's `clientInfo`. The SDK knows the host per session; start with the global switch.
