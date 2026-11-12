# Landing page restructure plan

Rework `apps/site/index.html` so the page tells one story: **you can add your own components to the chat, shaped around your own flows, and your customers use them.** The SDK proxy and self-hosting stay on the page, but as later steps for teams that need them, not as the first thing people read.

**Status (2026-10-26)**
- Done (2026-10-26). Open questions settled: option (c) with a softer demo caption, early-access wording kept, H1 "Your flows, in the chat." (changed 2026-11-09 to "Your UX, inside Claude and ChatGPT."). Follow-up: regenerate `public/og.png` (still shows the old tagline; its `og:image:alt` is left matching it).
- Changed from §3.2 on review: the main path doesn't assume staging. Using environments is up to each team, so the steps say "publish, connect, try it, share the address", and environments are one row under *What you can build*. The "Staging next to prod" block is gone.
- Copy and layout only. No new build steps, scripts or dependencies. `src/demo.ts` changes only if the hero demo changes (§3.1).

---

## 1. What's wrong today

The page leads with the hardest path. The hero says "adds … components to your MCP server", and step 1 of *How it works* is `mountAppMcp(server, …)`. So the reader learns they need their own MCP server and an SDK before they learn what they get.

| Section today | Problem |
|---|---|
| Hero: "UI for MCP Apps, released like code." | The message is about releasing. The value is UX that fits *your* use case. |
| How it works: Mount SDK → Model builds UI → Publish | Step 1 is the proxy. The main path (register, add, test, customers use it) isn't on the page. |
| What's included | Built-in forms and charts come first. Custom components, the main point, are 4th of 6. |
| Environments | Good content, but it's a separate section. It is the "test" step of the main path. |
| Your data stays on your server | Presents the proxy as how app-mcp works. It should be the option for flows that need your data. |
| Self-host | Hidden in a 3-item list under "Your data". |

## 2. Story and order

1. **Hero:** your flows, your UX, in the chat.
2. **How it works (the main path):** Register → Add your components → Test in staging → Your customers use it.
3. **What you can build:** custom components first, then recipes, then built-in forms and charts, theme and loading states.
4. **Need your own data? Connect your MCP server** (the proxy, secondary).
5. **Need it in your own network? Self-host** (tertiary).
6. **CTA.**

One visual rule makes the order clear: sections 4 and 5 are presented as levels on one "Going further" ladder (Hosted → With your data → Self-hosted), each going one step further than the one before.

## 3. Sections

### 3.1 Hero

- **H1, one of:**
  - "Your UX, inside Claude and ChatGPT." (live since 2026-11-09; replaced "Your flows, in the chat.")
  - "Give your customers UX that fits the job, inside Claude and ChatGPT."
  - "Components for your use cases, in every AI chat."
- **Sub:** Build the components your customers' flows need, publish them to app-mcp, and they show up in Claude, ChatGPT and other MCP Apps hosts. No MCP server needed to start.
- **CTAs:** "Get early access" (primary), "See how it works" (outline).
- **Trust line:** keep "Built on the MCP Apps standard…".
- **Demo:** the Packwell order form stays. It's a good "your own flow" example. Change the caption from "run on your tools" to something about the flow being the company's own, e.g. "A component Packwell built for reorders. The model opens it and fills in what it knows." The tool detail moves to §3.4. See open question 1.
- **`<title>` / meta / og:** switch from "released like code" to the new H1. `og.png` has the old tagline baked in, so regenerate it or note it as a follow-up.

### 3.2 How it works: four steps (replaces the current three)

Same card layout, four columns on `lg`, two on `md`. Each step has a short paragraph and a small code or UI snippet.

| # | Title | Copy | Snippet |
|---|---|---|---|
| 1 | Register | Sign in with GitHub, Google or your company's login. You get a workspace with prod and an MCP address your customers can connect to. | `https://app-mcp.com/w/acme/mcp` |
| 2 | Add your components | Write them with `@app-mcp/kit` in TypeScript or your framework, or describe a form as a recipe. Props are a Zod schema; the build is one HTML file. | `defineComponent({ … })` + `app-mcp publish --env staging` |
| 3 | Test them | Add the staging address as a connector next to prod. Try the flow in Claude or ChatGPT; tools end in `_staging` so you always know which one ran. | the env table (prod 1.2.0 / staging 1.3.0), shrunk |
| 4 | Your customers use it | Publish the tested version to prod without rebuilding. Customers add one connector, and running chats pick up the change. | `app-mcp publish rating@1.3.0 --env prod` |

The current **Environments** section is folded into step 3 plus a short "Staging next to prod" block beneath the steps. It keeps the table and the "registry is an MCP server too, admins manage it from the chat" paragraph. The nav link `#environments` goes away.

### 3.3 What you can build (renames "What's included")

Same `<dl>`, reordered and reworded around flows:

1. **Your components:** anything your flow needs: a seat picker, a quote builder, a rating. (`defineComponent`)
2. **Recipes:** forms your business owns: fixed fields and validation, the model only pre-fills. Each is a slash command. (`/create_order`)
3. **Forms and charts, built in:** for everything you haven't built yet.
4. **Your theme:** per environment, follows the host's dark mode.
5. **Loading states:** streaming fields, no double submits.

### 3.4 Going further, level 2: connect your own data (proxy)

Lead-in: *"When a flow needs your customers, orders or prices, connect app-mcp to the MCP server you already run."*

- Keep the `mountAppMcp` snippet (moved from today's step 1).
- Keep the data-flow diagram from today's "Your data" section, retitled: "Your data stays on your server".
- Keep the point that selects search your tools, charts load from your tools, and submit errors show next to the field (moved from today's step 2 and the Forms/Charts rows).
- Keep "Versions that never change" and "People confirm, not the model" as two small items here.

### 3.5 Going further, level 3: self-host

A short block, not a full section: *"Need nothing to leave your network? Run app-mcp yourself: the same registry as a Docker image, with your company's OIDC sign-in."* Plus a link to the CTA or contact. Check the runtime wording against the Cloudflare/Docker split: the current copy says "One Node process and a SQLite file".

### 3.6 Ladder visual

Three columns or stacked cards, with the first one highlighted:

| Hosted (start here) | With your data | Self-hosted |
|---|---|---|
| Register, publish, share the address | + your MCP server with the SDK | + app-mcp in your network |
| Components, recipes, forms, charts | Views call your tools; app-mcp never sees the results | Your database, your sign-in |

This can either replace the intros of 3.4 and 3.5 or sit just above them as a summary. I recommend putting it above them, so the reader sees all three levels before the details.

### 3.7 CTA and footer

- CTA copy: "Tell us the flow you want your customers to finish in the chat, and we'll help you ship the first component." Drop the requirement that teams already run their own MCP servers.
- Footer tagline: "Your components, in every AI chat."
- Nav: How it works · What you can build · Your data · Self-host.

## 4. Open questions

1. **Can the main path end in an action without the customer's own server?** On the hosted MCP alone, a component has no tools of the company's to call, so the Packwell "place order" can't be done without the proxy. Options: (a) keep the demo and accept a small stretch, (b) change the demo to a flow that fits the hosted path (the model fills a component, the customer confirms, the model carries on), or (c) say plainly in step 4 that actions on your systems come with level 2. I lean towards (c) plus a softer caption.
2. **Is registration actually self-serve?** `APP_MCP_ALLOWED_EMAILS` gates sign-up. If it's still invite-only, "Register" in step 1 should read "Get access" and the CTA stays early access.
3. **H1:** pick one of the three in §3.1.
4. **og.png:** regenerate now or later?

## 5. Done when

- The page reads hero → 4-step main path → what you can build → ladder → proxy → self-host → CTA.
- `mountAppMcp` doesn't appear above §3.4.
- Title, description and og tags match the new H1.
- `pnpm --filter @app-mcp/site build` passes, and the page has been checked at phone width and in dark mode in the preview.
