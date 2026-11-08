> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# v0.10.0 release review

Reviewed 2026-11-03 against `origin/main`, with `dev` at
`24249b4` (11 commits since main). Scope: every changed app/plugin source file,
dependency changes, existing tests and security handoffs, web packaging, release
versioning, and APK signing. This review did not use delegated agents.

## Findings addressed before release

1. **High: malformed-link denial of service.** Expo Router 57 uses query-string 7
   and decode-uri-component 0.2.2. The shipped decoder recursively retries invalid
   UTF-8 and repeatedly replaces encoded runs. npm flags GHSA-vcc3-ghjq-m6fr and
   GHSA-qr28-fpjm-wq7f. Vendored the fixed upstream 0.5.1 implementation with only
   a CommonJS export and the legacy plus-to-space behavior. A direct local
   dependency plus npm override selects it for Node and Metro. The original
   tarball integrity, source hash, license, and removal criteria are recorded in
   `app/vendor/decode-uri-component/README.md`; full notices ship in both products.
   Tests cover query-string integration, Unicode, partial encoding, no repeated
   decoding, and large malformed inputs in a bounded child process. The old
   installed decoder timed out after three seconds on 30,000 invalid bytes; the
   fixed implementation completes both regression workloads within the five-second
   test bound. This is an explicitly maintained compatibility build, not an
   assertion that npm has audited local vendored source.
2. **High: custom MCP OAuth lifecycle remains unresolved.** The original handoff
   explicitly warned that a pending sign-in can write credentials/configuration
   after removal, and tokens are keyed by server name. Source review of pinned
   Hermes confirms the worker persists configuration after its probe; Winglet
   custom saves/removal do not share that worker's transaction. Custom OAuth is
   deferred: reject creation/direct saves, refuse edits to legacy custom OAuth
   entries, and reject Winglet-initiated OAuth for custom entries. HTTP custom
   saves refuse names with cached OAuth tokens even for none/header authentication;
   unfinished Winglet flows block custom saves under that name. Existing catalog
   OAuth remains available. The new refusal tests fail against the prior dev
   implementation and pass with these guards. This closes the newly introduced
   custom OAuth path; it does not claim full token/provider invalidation or
   redesign existing catalog sign-in. Manage custom OAuth through Hermes.
3. **Medium: constrained-screen actions could be clipped.** Custom MCP forms and
   chat-bypass confirmations used non-scrolling sheets. Enabled their existing
   scrollable sheet mode so small windows, keyboards and larger text can retain
   access to the actions. No physical-device interaction was performed here.
4. **Release safeguard:** checking only for a non-debug certificate does not ensure
   an APK can update an existing install. The release workflow now requires the
   public production certificate fingerprint from the successful v0.9.0 run
   `40660360536`, and checks each APK's package name, versionName and versionCode.

## Other review conclusions

- Approval bypass is owner-signed, cross-checks the displayed chat and stored
  Hermes session key, accepts only a winning ordinary approval, and serializes
  turn-on/turn-off. Smart-denied cards and Rooms are excluded. The worker wake
  before enable can produce one extra approval and fails closed. Existing tests
  cover races and pinned-Hermes key mapping/gating; real-provider/device behavior
  is a separate QA layer.
- Room/project writes retain authorization, revision conflict checks and retry
  receipts. Room metadata is validated under its database transaction; project
  membership never grants Room access. A create-and-file failure keeps the Room
  and reports partial success. Metadata/access changes refresh tailored project
  snapshots; old servers retain focused polling and stale reads are ignored.
- MCP writes are owner-signed, stdio saves use an argument list, secrets are sealed
  and omitted from list/audit output, and quick-tunnel restrictions remain. Source
  URLs are sanitized. Arbitrary-source skill installation is still excluded.

## Local validation

- Full plugin suite: **735 passed, 33 skipped** (Hermes-dependent tests skip locally).
- App suite: **478 passed**, no failures or skips; TypeScript passes.
- Clean npm install/lockfile validation and `expo install --check` pass.
- Web export and Android/Hermes bytecode export pass; rebuilt `plugin/web` has
  **28 asset references, zero missing**. Third-party notice check passes.
- Targeted abilities, versions and notices: **39 passed** after final backend cleanup.
- npm audit: **15 dependency entries: 2 high, 11 moderate, 2 low, zero critical**,
  down from 18 entries (5 high) at review start. Remaining high entries are Zod
  and its Expo CLI parent; the other root advisories are deepmerge, glob and
  minimatch in Expo build/config tooling. The local fork is independently
  regression-tested. No Expo SDK major or incompatible Zod override was forced.

## Required remote gates and remaining limits

Before promotion, require all CI jobs, including pinned Hermes and Wear native
compilation, plus the Release workflow on the promotion PR to main. That workflow
builds signed APKs and the plugin without publishing and reports as PR checks,
so completion is tracked alongside CI. Internal promotion PRs require the signing
key. A separate manual validation run is also available. Verify the certificate
and APK version checks. After promotion, tag the exact main commit `v0.10.0`;
the tag workflow publishes only after tests and both artifact jobs succeed.

Physical iPhone/Safari Home Screen QA and installed Android update testing remain
unperformed. Native iOS/TestFlight, Room-wide approval bypass, arbitrary-source
skill install, and the 90-day offline-deletion convergence design are outside this
release. Long-offline devices may retain deleted cached messages after server
tombstones expire; do not describe that existing limitation as fixed.
