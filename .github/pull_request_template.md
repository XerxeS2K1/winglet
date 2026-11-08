## What and why

<!-- One or two sentences: what changed, and why it is needed. -->

## Checklist

- [ ] Tests added or updated, and they pass: `pytest -q` for the plugin; `cd app && npx tsc --noEmit && npm test` for the app.
- [ ] Docs updated in this same pull request if behaviour or screens changed: README, `docs/FEATURES.md`, `docs/BOTS.md`, `docs/DESIGN.md`, plus `docs/APP_PLAN.md` (current status), `docs/SERVER_PLUGIN_UPDATE.md` (update path) and `docs/DEVICE_LINKING.md` (pairing) where relevant.
- [ ] If `app/` changed: I did not rebuild `plugin/web` here. Every rebuild renames its files, so two branches that rebuild always conflict; the release pull request rebuilds it once.
- [ ] I have separated local integration and rebuild evidence from approved publication/deployment. Local tests and test doubles are not a release, an install or a gateway restart.

### Release pull request only (integration branch to `main`)

- [ ] Every tracked `.md` file was inventoried, read and classified; the per-file audit records current fixes and historical/legal/generated/template dispositions, and `docs/APP_PLAN.md` records the exact integration state.

- [ ] Version bumped everywhere (`plugin/plugin.yaml`, `plugin/hub.py`, `app/app.json`, `app/package.json`), `docs/releases/vX.Y.Z.md` written, and the README "New in" banner updated. `python scripts/check_release_docs.py` passes.
- [ ] Web bundle rebuilt with `./scripts/build-web.sh` after the version bump, and `plugin/web` committed (`python scripts/check_web_bundle.py` and `--fresh` pass).
- [ ] Final Reviewer cold review of the exact combined commit has no blocker; its report and the test/typecheck/web evidence are recorded in `docs/APP_PLAN.md`.
