# Releasing Winglet

Replace `VERSION` below with the release version (for example `0.10.7`). Pushing a tag like `vVERSION` builds the Android APKs and the plugin bundle and publishes them as a
GitHub Release. There is one APK per CPU, `winglet-<version>-arm64-v8a.apk` (nearly every phone) and
`winglet-<version>-armeabi-v7a.apk` (older 32-bit phones), about 61 MB and 52 MB against 81 MB for a universal one. Both share
the release's versionCode, and the app's update check downloads the one that fits the phone.

The tag sets the app version: `vVERSION` becomes version `VERSION`, Android versionCode
`101` (major × 10000 + minor × 100 + patch), so every release installs as an update over the last.

The release workflow checks both APKs' package name, versionName and versionCode,
and requires this fork's release signing certificate. Its public SHA-256
fingerprint is `48be2677740ba3ba5c2b93e0195906ebdcc3b7525cb32acbf86090807fa279ae`.
Changing a signing secret alone must not silently publish APKs that existing users
cannot install as updates. Any planned key rotation needs a separate upgrade plan
and an intentional update to that check.

## Before tagging: rebuild the web app

`hermes plugins install` and `hermes plugins update` take `plugin/` from git, so the web app they serve is the
one committed in `plugin/web`, not the one the release workflow builds. The order matters:

1. Bump the version files (see "Cutting a release" below). `app/app.json` and `app/package.json` are part of what the
   bundle is built from, so a bump makes the bundle stale.
2. Run `./scripts/build-web.sh`. It rebuilds `plugin/web` and writes `plugin/web/source-stamp.txt`.
3. Commit `plugin/web`.
4. Check it: `python scripts/check_web_bundle.py --fresh` must print "plugin/web matches the app source".
5. Tag.

The release workflow runs the same `--fresh` check on the tag push and stops the release if the app source has changed
since the bundle was built. That is late (the tag already exists, and has to be deleted and pushed again), so do step 4
yourself first. Pull requests and manual runs do not run it.

Rebuild once, after the final merge into the release line, not on every feature branch: the bundle's file names change
with every build, so two branches that each rebuild always conflict. A feature branch that changes `app/` leaves the
bundle stale, and that is expected until the release is prepared.

The release candidate is not ready when this file's version numbers are merely changed. Complete the audit in
[APP_PLAN.md](APP_PLAN.md): every affected tracked Markdown file is updated; the combined server/app tests and
typecheck are rerun and their known/uncertain failures recorded honestly; the generated web bundle and both
`check_web_bundle.py` checks match; a Reviewer cold review of the final combined commit has no blocker. A local
test double or sandbox rollback is not a real install, gateway restart or phone verification. Rebuilding and
committing `plugin/web` does not publish it, and neither grants permission to install or restart the gateway.

## One-time setup: your signing key

Android only installs an update if it's signed with the same key as the version already installed,
and the key proves the APK came from you. CI refuses to publish a release without it.

1. Create a key (needs Java; any machine works). Keep the file and passwords somewhere safe and
   **never commit them**. If you lose this key, users have to uninstall to get future updates.

   ```bash
   keytool -genkeypair -v -keystore winglet-release.keystore -alias winglet \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Turn it into text for GitHub:

   ```bash
   base64 -w0 winglet-release.keystore > keystore.txt   # macOS: base64 -i winglet-release.keystore
   ```

3. In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**,
   add four secrets:

   | Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | contents of `keystore.txt` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | `winglet` |
   | `ANDROID_KEY_PASSWORD` | the key password |

## Cutting a release

Releases are cut from `main`. Day-to-day work lands on `integration/dev-all`; a release is a pull request from there to
`main`, and the version tag goes on `main`. Every feature pull request already updates the docs it affects (the
pull request template has the checklist), so at release time only the release notes and the README banner are left to write.

The documented `integration/dev-all` convention is historical for this fork's current branches. For the pending
updater and linking integration, a new branch is `fix/plugin-update-combined`, based on current `main` (`7b47f12`);
the old `feat/device-link-*` branches are source inputs, not release branches. Do not invent that they have been
merged to `main` or released. Version selection, integration/rebase order and release mechanics require Kraig's
explicit approval; do not overwrite an existing release tag or reuse a published version's number.

1. **Prepare on `integration/dev-all`.** Set the same version in `plugin/plugin.yaml`, `plugin/hub.py` (`VERSION`),
   `app/app.json` and `app/package.json`. Write `docs/releases/v<version>.md`; its first line must be `# Winglet v<version>`.
   Point the README "New in" banner at it: `> **New in [v<version>](docs/releases/v<version>.md):** ...`.
   Run `python scripts/check_release_docs.py`; it names every file that is still wrong, and the release workflow runs the same
   check, so a tag without its notes and banner is refused.
2. **Rebuild the web app.** Run `./scripts/build-web.sh` after the bump (the bump changes what the bundle is built from),
   then commit `plugin/web`. Do it once, after the last feature has merged: the bundle's file names change
   with every build, so two branches that each rebuild always conflict.
3. **Open a pull request from `integration/dev-all` to `main`.** The Release workflow runs on it as a validation: it checks the
   release documents and builds the APKs and the plugin without publishing. Internal PRs require the production
   signing key; fork PRs can build with a debug key. Merge only after these checks and CI pass.
4. **Merge it, then tag `main`.**

   ```bash
   git switch main && git pull
   git tag v0.1.1
   git push origin v0.1.1
   ```

5. **The tag publishes.** The Release workflow checks the tag against `plugin/plugin.yaml` and the release documents, builds
   both APKs and the plugin bundle, and publishes the GitHub Release. It also refuses a tag whose commit is not on `main`,
   so nothing is published from any other branch.

### Betas

A tag like `v0.2.0-beta.1` (or `-rc.1`) publishes a **pre-release**: the app shows `0.2.0-beta.1`,
and GitHub keeps "Latest release" on the last full release. A beta shares its release's versionCode
(`v0.2.0-beta.1` and `v0.2.0` are both `200`), so the final release installs over the beta as an update.

### Release notes

`docs/releases/<tag>.md` (for example `docs/releases/v0.2.0-beta.1.md`) is required: the release check refuses a tag without
it, and the README banner must name the same tag. It becomes the top of the release page, above GitHub's list of merged
pull requests.

Manual runs from the Actions tab build test artifacts only. Without the key secrets those APKs are
signed with the public debug key and named `…-debugkey.apk`: fine for trying things out, not for
sharing.
