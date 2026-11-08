# Server-plugin update: path, safety and bootstrap

The Android APK and the server plugin are separate installations. Installing an APK does not
replace server Python files, and installing server Python does not update the APK or restart
the gateway by itself. Neither half of a fix can be inferred from the other version number.

## End-to-end path

1. The APK and plugin remain distinct installations. The unified app-update correction coordinates
   them from one app Update action; its exact stage ordering and local-only status are recorded
   below and in APP_PLAN.md. The released 0.10.7 APK updater handled them separately.
2. `ServerUpdatePrompt` and the Server screen check `/api/system/updates`. For Winglet,
   `Hub._winglet_release_status` asks the hard-coded `XerxeS2K1/winglet` releases API, not
   Hermes's Git-provenance checker. Subdirectory installs have no `.git` and that checker
   otherwise reports drift forever.
3. The phone requires a fresh local unlock and signs `POST /api/system/update` with
   `{target: "winglet", version: "X.Y.Z", idempotency_key: "..."}`. Unlock is a phone UX
   gate, not server-verifiable proof of biometrics; server authorization is the owner signature.
4. Owner-signed route policy authenticates the request. The server resolves the newest stable
   release again, requires that exact version and a numeric upgrade, resolves its tag to a
   full 40-character commit, checks the manifest version and Hermes compatibility. Client
   repo, branch, URL and SHA fields do not select the source. Retries return the same job.
5. The server persists a job and broadcasts `system.job`. Before installation it snapshots
   plugin files, the install-metadata entry and SQLite; copies the running rollback script;
   creates a bounded no-agent watch job; and writes a pending marker. A preparation failure
   prevents installation.
6. `hermes_api.install_release` invokes Hermes using an argument vector (never a shell):

   ```text
   plugins install XerxeS2K1/winglet/plugin --ref <resolved-full-sha> --force --no-enable --yes-deps
   ```

   Standard input is closed. `--yes-deps` supplies the Python dependency consent required
   for replacing an already-selected plugin non-interactively, including with `--no-enable`.
   It is not `--yes` for all questions: capability grants and Node-sidecar consent are separate.
   Hermes still owns dependency admission/publication. `--force` is pre-existing: replace
   the old tree and accept caution-level scan results, not a dangerous verdict or kill-list
   removal. No `--allow-removed`, `--no-deps`, arbitrary source or unpinned ref is used.
7. Nonzero exit, exceptions or a wrong manifest version restore files and install metadata,
   preserve messages written meanwhile, finish the job as failed and do not request a restart.
8. Success is only *installed*, not yet *running*. The job waits for all bots to become idle,
   refreshes the database backup when necessary, arms the boot deadline and requests a
   restart. A fresh gateway reconciles the durable job and pending marker. Failed boot
   rollback does not restart the gateway: manual recovery remains the owner's decision.
   Watch rollback, lease renewal, boot settlement and the final restart decision share an
   OS file lock. The pending backup identity is checked again immediately before requesting
   restart, so a rollback during the phone-event delay cannot be revived. Reconciliation
   requires the actual running version to equal the requested target; it never overwrites
   that target with an unrelated version.
9. Existing read-only owner APIs `/api/system` (recent jobs), `/api/jobs` and
   `/api/jobs/{id}` recover progress across transport loss. A `system.job` event alone is
   not durable client tracking. The phone must retain its job/request identity and terminal
   acknowledgement independently of a mounted sheet.

## Security boundary and remaining limits

- The signed owner's update tap authorizes the pinned trusted release **and its declared
  Python dependencies**. This is not a general-purpose remote package installer. A compromised
  trusted repository, GitHub account or declared dependency remains within the trust risk.
- Releases have no independent signature/checksum verification; this is the existing accepted
  repository-and-owner-tap trust model. Git SHA pinning is not a publisher signature.
- The child environment is allow-listed; provider keys/tokens are not inherited directly.
  The child still runs as the same OS account and uses Hermes home, so this is **not a sandbox**
  and does not prevent trusted installer code reading files or Hermes loading its own settings.
- Backup rollback covers plugin files, their install-metadata entry and, only if new code ran,
  the Winglet SQLite database. It does not restore the entire shared Python environment or
  undo arbitrary dependency side effects. Dependency admission is Hermes's responsibility.
- The rollback watch is Hermes cron, which requires a running gateway ticker. It is not an
  independent systemd watchdog and cannot guarantee recovery from a completely dead gateway.
- The installer has a bounded runtime and output returned to the phone is cleaned/capped.
  On timeout or cancellation it stops the inherited process group and reaps the launcher
  before returning to rollback (Windows uses taskkill /T). The process-group integration
  tests ran on Linux; Windows tree termination/locking still need native verification.
  A malicious dependency can deliberately escape an inherited group: this is not a sandbox.
  Real package/network execution and native phone lifecycle are separate acceptance tests.

## Historical failure and bootstrap for 0.10.5/0.10.6

Before the bootstrap on 2026-11-08: APK 0.10.6 (owner-reported), live plugin manifest 0.10.5,
Hermes 0.23.0. Job `44f2e0e22339415b` failed because the live installer omitted
`--yes-deps`. Backup `plugin-0.10.5-pre-0.10.6-20261108-085709` is named in its
record. The refusal explicitly says the installed plugin and active environment were unchanged;
Winglet additionally restored old plugin files and did not restart the gateway.

The 0.10.5 plugin already supports the release API, signed update route and durable jobs.
It does **not** contain this repaired command. Published 0.10.6 has the same omission.
Thus neither updating the APK nor publishing a future repaired plugin can repair the updater
that is already loaded: that old code must successfully install its replacement first.

A separately approved **manual pinned server-plugin bootstrap plus gateway restart** is needed
once (or an explicitly approved minimal patch to the live updater plus restart). Prefer a
reviewed pinned repaired release rather than an undocumented hot patch. Back up the live
plugin, metadata and database first; verify installed bytes and version independently; the
owner controls restart approval. Only after repaired server code is loaded can a later
phone-triggered update exercise the repaired self-update path. Do not retry the broken
0.10.5 updater and expect a new APK to supply a CLI flag.

For this server the bootstrap was completed from released v0.10.7 at commit `f33a2c1`; the owner
restarted the gateway at 11:45 on 2026-11-08, then `/api/info` reported 0.10.7 and the phone
reconnected. That dated verification does not prove which APK is installed. Other machines still
running the broken 0.10.5/0.10.6 updater need the one-time bootstrap above. The new unified-flow
correction is local only and does not perform another install, restart or publication.

Related: [DESIGN.md](DESIGN.md) (job and sheet behaviour), [APP_PLAN.md](APP_PLAN.md) (current
status and gates), [DEVICE_LINKING.md](DEVICE_LINKING.md) and
[HERMES_COMPATIBILITY.md](HERMES_COMPATIBILITY.md). Parent-reported app tests, server tests,
Reviewer review, web freshness and phone approval are separate gates; none is a substitute for
another, and none has been silently counted as a full pass.

## Unified app update — local correction

The separate owner opt-in auto-update toggle was rejected and is not the intended product.
One app Update action must coordinate the APK and the matching pinned server-plugin release;
there is no setting that installs server releases whenever they appear. Android still owns the
required APK installation confirmation. The app must not report installation merely because it
opened that confirmation, and cancellation/failure must remain distinguishable from success.

The server update remains a signed owner action bound to one pairing and exact release version.
A member cannot update the server, an unrelated/newer release cannot be substituted, and a newer
installed plugin cannot be downgraded. The explicit Server repair/status row remains available.
See [APP_PLAN.md](APP_PLAN.md) for the exact implementation commit, flow ordering, recovery
behaviour and verification state. This correction is not yet published or phone-verified.

## Offline verification scope

- Command regression asserts the exact pinned argv including `--yes-deps`, stdin closed,
  invalid SHA refusal, minimal environment and cleaned output. The new expectation fails
  against the old command.
- Signed HTTP tests cover owner/member/unsigned requests, release lookup and compatibility,
  idempotency, backup preparation, failures, restart waiting and boot reconciliation.
- Cold-review safety probes were independently reproduced red before repair. Regressions
  cover watch rollback before the first quiet check and during the event delay; serialized
  restart/watch decisions; absent/wrong backup identity; timeout/cancellation with a real
  benign descendant writer; mismatched version and unrelated boot markers.
- `test_plugin_update_rehearsal.py` joins signed HTTP, real backup/SQLite and a real child
  process. Its installer **test double** uses the actual Hermes argument parser and
  active-plugin dependency-consent gate, but substitutes PM publication with sandbox writes.
  It reproduces the old refusal, tests success plus simulated fresh boot, and injects partial
  publication failure to prove real rollback preserves intervening messages and metadata.
- This is not evidence of a real GitHub download, package-manager installation, gateway
  restart, Telegram rollback delivery or Android-native install. Those remain approval-gated.
