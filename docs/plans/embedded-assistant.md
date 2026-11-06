# Embedded assistant implementation

- [x] Add reusable app-mcp host rendering with sandbox, theme, tool callbacks and lifecycle.
- [x] Add TanStack chat integration, model/MCP server helpers and complete documented starter.
- [ ] Verify app-mcp with tests and browser in its isolated worktree; release packages if needed.
- [x] Add GeoGeo authenticated persisted planning conversations and bounded Cloudflare model loop using existing MCP.
- [x] Add shared sourced-place research tools; preserve draft and on-site-check workflow.
- [x] Add Polish planning chat with existing mystery map/editor and management entry.
- [ ] Typecheck, lint, simplify, review, verify permissions/retries and real browser interaction.
- [ ] Make GeoGeo testable for user review before landing.

Out of scope: PDF imports, image generation, owning customer databases/auth in app-mcp, additional framework adapters.
Verification: automated protocol/security/retry tests, package consumer starter, GeoGeo migrations and browser scenarios, live Cloudflare smoke test if credentials permit. Record limitations honestly.

Verification so far: official MCP bridge tested with GeoGeo map/editor save and built-in form submission + model follow-up; typed checks and repo tests pass. GeoGeo tests cover ownership, revoked membership, blocked accounts, daily limits and request replay. Live GLM research quality was insufficient; GeoGeo defaults to Cloudflare GPT-OSS-120B with low reasoning.
