## What and why

<!-- One or two sentences: what changed, and why it is needed. -->

## Checklist

- [ ] Tests added or updated, and they pass: `pytest -q` for the plugin; `cd app && npx tsc --noEmit && npm test` for the app.
- [ ] Docs updated in this same pull request if behaviour or screens changed: README, `docs/FEATURES.md`, `docs/BOTS.md`, `docs/DESIGN.md` (whichever apply).
- [ ] If `app/` changed: I did not rebuild `plugin/web` here. Every rebuild renames its files, so two branches that rebuild always conflict; the release pull request rebuilds it once.

### Release pull request only (`integration/dev-all` to `main`)

- [ ] Version bumped everywhere (`plugin/plugin.yaml`, `plugin/hub.py`, `app/app.json`, `app/package.json`), `docs/releases/vX.Y.Z.md` written, and the README "New in" banner updated. `python scripts/check_release_docs.py` passes.
- [ ] Web bundle rebuilt with `./scripts/build-web.sh` after the version bump, and `plugin/web` committed (`python scripts/check_web_bundle.py` passes).
