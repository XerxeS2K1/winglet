# Releasing Winglet

Pushing a tag like `v0.1.1` or `v0.2.0-beta.1` builds the Android APKs and the plugin bundle and publishes them as a
GitHub Release. There is one APK per CPU, `winglet-<version>-arm64-v8a.apk` (nearly every phone) and
`winglet-<version>-armeabi-v7a.apk` (older 32-bit phones), about 61 MB and 52 MB against 81 MB for a universal one. Both share
the release's versionCode, and the app's update check downloads the one that fits the phone.

The tag sets the app version: `v0.1.1` becomes version `0.1.1`, Android versionCode
`101` (major × 10000 + minor × 100 + patch), so every release installs as an update over the last.

The release workflow checks both APKs' package name, versionName and versionCode,
and requires the production signing certificate used by v0.9.0. Its public SHA-256
fingerprint is `bd45603350eb7873f0b3034c57762375689822b8cfa3b9aa5ea2965ad36bb86e`.
Changing a signing secret alone must not silently publish APKs that existing users
cannot install as updates. Any planned key rotation needs a separate upgrade plan
and an intentional update to that check.

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

Promotion PRs to `main` run the Release workflow as validation checks, building
the APKs and plugin without publishing. Internal PRs require the production
signing key; fork PRs can build with a debug key. Merge only after these checks
and CI pass. The tag below performs the final build and publication.

```bash
git tag v0.1.1
git push origin v0.1.1
```

### Betas

A tag like `v0.2.0-beta.1` (or `-rc.1`) publishes a **pre-release**: the app shows `0.2.0-beta.1`,
and GitHub keeps "Latest release" on the last full release. A beta shares its release's versionCode
(`v0.2.0-beta.1` and `v0.2.0` are both `200`), so the final release installs over the beta as an update.

### Release notes

If `docs/releases/<tag>.md` exists (for example `docs/releases/v0.2.0-beta.1.md`), it becomes the top of
the release page, above GitHub's list of merged pull requests.

Manual runs from the Actions tab build test artifacts only. Without the key secrets those APKs are
signed with the public debug key and named `…-debugkey.apk`: fine for trying things out, not for
sharing.
