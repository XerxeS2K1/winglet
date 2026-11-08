> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# Custom MCP servers and skill sources

## Release disposition (2026-11-03)

The original handoff below records the implementation's unresolved OAuth blocker.
The v0.10.0 release review disables custom OAuth creation, editing of legacy custom
OAuth configurations, and Winglet sign-in for custom entries. The app offers only
none/header authentication for custom HTTP servers. Existing catalog sign-in stays
available. Creating a new HTTP entry also refuses a name with cached OAuth tokens,
regardless of the requested authentication type; an unfinished Winglet sign-in
blocks custom saves under that name. This does not implement OAuth invalidation.
Full custom OAuth remains deferred until credential/provider/flow lifecycle is
serialized and validated. HTTP/header and stdio custom connections can ship.

Regression tests exercise POST/PUT refusal, direct persistence refusal, legacy
custom sign-in refusal, active-flow/name reuse, retained tokens with none/header,
and continued sign-in for non-custom entries. See `release-review-v0.10.0.md` for
final validation and remaining limitations. Historical statements below about
uncommitted work and absent CI describe the original implementation only.

Status: **BLOCKED — OAuth credential invalidation remains unresolved**. Branch `feat/custom-mcp-and-skills`, worktree `C:\Users\vikas\Documents\winglet-agents\A3-abilities`, base `f30d2f16bf9c5158ca40af567b51a97be6abb0a2`; changes are uncommitted. CI and pinned-Hermes testing have not run.

## Contract

- Owner-only skill reads expose a source link when Hermes provides a safe URL; official Hermes catalog and installed skills link to the documented `optional-skills` folder in the Hermes repository. URL-shaped installed identifiers have userinfo, query and fragment stripped before display; unsafe URLs are not used as links.
- Custom skill installation from a link is **not included**. Hermes's `hermes_cli/skills_hub.py` `_pinned_sources` / `_install_skill` resolves through multiple adapters, and `tools/skills_hub_search.py` plus `tools/skills_hub_official.py` allow the official adapter's basename fallback. A submitted repository path or even URL may therefore install a different official skill. A safe future implementation needs a Hermes-supported pinned-source install operation (with exact source/identifier confirmation), and must verify the lock/provenance after completion rather than treating process exit code zero as installation success: `hermes_cli/skills_hub.py` `do_install` / `_install_skill` can return zero after a missing skill or scan refusal.
- `POST /api/mcp/custom` and `PUT /api/mcp/custom/{name}` are `owner_signed`; they save custom HTTP or stdio entries through Hermes. Catalog, configured and plugin name collisions are rejected, and plugin/non-Winglet entries cannot be edited here. Existing remove, test and OAuth actions are reused.
- HTTP requires HTTPS or loopback/private-literal HTTP and disallows credentials, query strings and fragments. Each newly saved or edited custom HTTP entry has `strict_redirect_headers: true`. In the inspected Hermes checkout, `tools/mcp_tool_server_run.py` and `tools/mcp_tool_transport.py` read that exact key and `tools/mcp_tool_errors.py` enforces the redirect-header boundary. Existing configs are not migrated automatically; compatibility with pinned Hermes remains unverified.
- Stdio stores the executable and argument list without a shell; the app requires review and confirmation. Header and env values use the existing `mcp-env` sealed payload, are omitted from MCP list responses and audit summaries, and obey the quick-tunnel web secret restriction. Hermes persists them in its config file. A blank secret edit retains existing values; stdio arguments must be re-entered because GET omits them.
- Add/edit audit summaries name the server and set the reconnect hint. No database migration; `plugin/web/` is unchanged.

## Blocking OAuth limitation

Hermes keys OAuth tokens and providers by server name. As a temporary fail-closed measure, edits cannot change any custom server's URL or transport; callers must not consider this a complete fix. Removing and re-creating a server under the same name may retain old OAuth credentials, and a pending OAuth flow is not cancelled by this restriction. The requested work to invalidate tokens/providers and cancel pending sign-in was blocked by a tool permission denial for secret-store writes. Do not merge or use custom OAuth until an authorized implementation addresses token/provider lifecycle, pending-flow races, remove/recreate, profile scoping and tests. Use a fresh name as a temporary precaution, not as proof of safety.

## Verification

- Full plugin suite: 684 passed, 31 skipped, 0 failed. App TypeScript check passed; 458 app tests passed, 0 failed or skipped. Tests use fakes; no real MCP server or remote skill was run.
- Red/green tests in the worktree cover strict redirect configuration, denial of address changes and URL identifier sanitization. These do not validate OAuth credential invalidation, which was not implemented.
- Available Hermes checkout `7239625ae1b786827c952a8ace41fa6fd7f2eec5` differs from CI pin `47676981f55de91231fdeef2f0eec47e7c209e78`; pinned-Hermes: CI only.
- Earlier `npm ci` reported 12 dependency vulnerabilities (6 low, 3 moderate, 3 high); no dependency upgrades were made. No phone, browser, real OAuth or reconnect checks were performed.

## Phone QA after the blocker is fixed

Check source links and missing links, custom HTTP/stdio add/edit/remove and exact-command confirmation, sealed secrets and quick-tunnel restrictions, collision and reconnect messages, member refusal, real OAuth sign-in and cross-origin transitions, both themes and large text. Use test servers and non-sensitive fixtures.
