> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# Dependency audit — October 2026

Scope: A4a only, based on the 2026-10-28 production npm audit and a new audit on 2026-10-29. This changes dependency versions only: no routes, policies, storage contracts or app screens change. The web bundle in `plugin/web/` was not rebuilt here.

## Decisions and evidence

- `npx expo install` updated Expo and nine SDK 57-managed packages to the versions recommended by Expo; `npm ci` and `npx expo install --check` subsequently succeeded. The initial install exited 1 after updating the packages because Expo could not add the optional `expo-sharing` and `expo-sqlite` config plugins to the dynamic `app.config.js`. No config change was made; native prebuild and plugin-specific native behavior remain unverified.
- npm audit counts dependency entries, including packages flagged solely because of a vulnerable transitive dependency; they are not distinct advisories. Counts changed from 16 (6 low, 6 moderate, 4 high) to 12 (6 low, 3 moderate, 3 high), with zero critical. The updated node-forge, xcode, uuid and @expo/config-plugins entries disappeared.
- A web export source map contains both `query-string` and `decode-uri-component`. This establishes inclusion, not exploitability or Android reachability. The Expo tooling classifications below are based on their installed dependency paths; absence from the inspected web source map is not proof about every native build or runtime path. `expo` and `expo-share-intent` themselves also have runtime code; their npm flags are propagated from the listed build-tool paths, not a claim that the packages are wholly build-only.
- No risky overrides were applied. The fixed `decode-uri-component` 0.5 line is ESM, whereas router's `query-string` 7 uses CommonJS and requests the 0.2 line. Forcing an incompatible module across that boundary would not be a safe patch. `deepmerge` 4.3.1 is the latest available and affected; Zod 3.25.76 is the latest 3.x, whereas the advisory identifies a fix in 4.6.6. A forced Zod major is not established compatible with the SDK 57 CLI. The audit's Expo 51 downgrade and router 58 major upgrade were deliberately rejected.

## All 16 original npm audit entries

Paths are representative `npm ls --all` paths. Severity is from the original audit; status is after the SDK 57 updates.

| Package (original severity) | Path / shipped scope | Status and reason |
| --- | --- | --- |
| `@expo/cli` (high) | `expo → @expo/cli → zod`; build tooling | Build-tool only; still open through Zod and `@expo/config`. |
| `@expo/config` (low) | `expo → @expo/config → deepmerge`; build/config tooling | Build-tool only; still open through deepmerge. |
| `@expo/config-plugins` (moderate) | `expo-share-intent → @expo/config-plugins → xcode`; native build tooling | Fixed: SDK patch resolves 57.0.11 and xcode 4.0.0. |
| `@expo/local-build-cache-provider` (low) | `expo → @expo/local-build-cache-provider → @expo/config → deepmerge`; build tooling | Build-tool only; still open through deepmerge. |
| `@expo/metro-config` (low) | `expo → @expo/metro-config → @expo/config → deepmerge`; build tooling | Build-tool only; still open through deepmerge. |
| `@expo/prebuild-config` (low) | `expo → @expo/cli → @expo/prebuild-config → @expo/config → deepmerge`; build tooling | Build-tool only; still open through deepmerge. |
| `decode-uri-component` (moderate) | `expo-router → query-string → decode-uri-component`; present in web runtime source map | Still open, [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr); compatible fixed release not established. |
| `deepmerge` (low) | `expo → @expo/config → deepmerge`; build tooling | Build-tool only; still open, [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4); no fixed 4.x release available. |
| `expo` (high) | Direct; audit flag propagates from `@expo/cli` and config tooling | Still open as an umbrella entry for build-tool findings; Expo also provides shipped runtime modules. |
| `expo-router` (moderate) | Direct → `query-string → decode-uri-component`; web runtime | Still open through decode-uri-component; SDK 57 router 57.0.29 remains affected. |
| `expo-share-intent` (low) | Direct → `expo → @expo/cli/@expo/config`; plugin/runtime package | Still open as an umbrella entry for build-tool findings; its own runtime code is shipped. |
| `node-forge` (high) | `expo → @expo/cli → node-forge` and `@expo/code-signing-certificates → node-forge`; build/signing tooling | Fixed: 1.4.2, outside [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) range. |
| `query-string` (moderate) | `expo-router → query-string → decode-uri-component`; present in web runtime source map | Still open through decode-uri-component. |
| `uuid` (moderate) | `expo-share-intent → @expo/config-plugins → xcode → uuid`; build tooling | Fixed: xcode 4 no longer brings the affected uuid path; [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). |
| `xcode` (moderate) | `expo-share-intent → @expo/config-plugins → xcode`; native project build tooling | Fixed: SDK 57 config plugins resolve xcode 4.0.0. |
| `zod` (high) | `expo → @expo/cli → zod`; build tooling | Build-tool only; still open, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5); no compatible 3.x fix found. |

## Python

`pip-audit 2.10.1` was installed in the worktree's ignored `.venv`. Requirements copied from `plugin/plugin.yaml` were resolved and audited on Windows/Python 3.12: aiohttp 3.14.5, cryptography 50.0.2, httpx 0.28.1, qrcode 8.2 and their resolved transitive dependencies yielded no known vulnerabilities. This checks one current resolution, not every version permitted by the broad ranges or Hermes's pinned environment. No Python range was changed: raising a floor could disable the plugin when Hermes pins an older dependency, without evidence of compatibility. The initial whole-venv audit flagged only the venv's pip 25.0.1; upgrading that throwaway tool to 26.2.2 made the environment audit clean.

## Local verification and limits

- Plugin suite with the existing shared Python: 666 passed, 31 skipped; no plugin code or Hermes integration changed.
- Existing bundled web reference check: 28 references checked, none missing.
- App TypeScript: passed; app tests: 456 passed, 0 failed, 0 skipped.
- Expo web and Android JavaScript exports: passed. Web source map confirms the two query-decoding packages are included.
- A clean `npm ci` followed by Expo compatibility check passed. The exports and tests preceded that clean reinstall, which restored the same lockfile.
- No native Android/iOS compilation, installed-app or device validation, native prebuild or CI was performed. No new behavioral regression test or red check was added: the changes are version/lockfile updates, not a targeted code behavior fix. Owner/reviewer should evaluate the optional plugin warning and monitor upstream fixes, especially the shipped URL decoder. CI and a rebuilt `plugin/web/` remain reviewer responsibilities.
