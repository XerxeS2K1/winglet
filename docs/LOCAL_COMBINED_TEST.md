# Combined local test rehearsal

This local branch combines the reviewed web freshness gate, hand-off queue titles, server plugin updater,
main-based release/document checks, background-task activity and session-scoped fallback detail.
The existing bot features in the recorded main snapshot are retained. See [bot handling](BOTS.md),
[features](FEATURES.md) and [release checks](RELEASING.md).

The updater waits for a quiet gateway after a successful install; failures do not trigger an automatic restart.
Rollback preserves the database unless the newly installed plugin actually started, and records its attempt before
restoring anything. These paths have automated coverage, not a live update/rollback trial in this rehearsal.

Version stays at 0.10.4 for this local test. The generated artifact is the bundled WEB app in `plugin/web`, not an
Android APK. Theme audit/fixes are unfinished and excluded. Nothing here claims phone or Android testing, a release,
an installation, or a live gateway change. This rehearsal does not push or create a tag.
