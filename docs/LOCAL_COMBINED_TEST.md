# Combined local test rehearsal

> **Historical rehearsal.** This describes a 0.10.4-era local branch and its test counts. It is
> kept as history, not as current evidence. For present status and gates see
> [APP_PLAN.md](APP_PLAN.md).

This local branch combines the reviewed web freshness gate, hand-off queue titles, server plugin updater,
main-based release/document checks, background-task activity and session-scoped fallback detail.
The existing bot features in the recorded main snapshot are retained. See [bot handling](BOTS.md),
[features](FEATURES.md) and [release checks](RELEASING.md).

The updater waits for a quiet gateway after a successful install; failures do not trigger an automatic restart.
Rollback preserves the database unless the newly installed plugin actually started, and records its attempt before
restoring anything. These paths have automated coverage, not a live update/rollback trial in this rehearsal.

Version stays at 0.10.4 for this local test. The generated artifact is the bundled WEB app in `plugin/web`, not an
Android APK. This descendant includes the selected-theme battery explanation, shared input defaults and safe Devices
empty state, plus the source audit in [THEME_AUDIT.md](THEME_AUDIT.md). Theme work is included in the web source/bundle;
that does not certify rendered route states or Android keyboard/permission behaviour. Nothing here claims phone or
Android testing, a release, an installation, or a live gateway change. This rehearsal does not push or create a tag.
