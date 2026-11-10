# The server updates itself; the app updates itself

Status: agreed with the owner, 2026-11-09. Supersedes the one-tap handoff (v0.10.11).

## Why the current model is wrong

Until now the phone sent the server plugin update, then handed itself to Android's installer. That
puts a server change in the hands of a client process which is about to be killed, and produces
everything we have been patching around: owner consent bound to a device signature, stage tracking
across a restart, "the server was already updated and cannot be undone" messages, restart notices,
stale-offer guards, two entry points, and a lost-reply recovery path.

The update is not one operation. It is two, owned by two different machines.

## The model

- **The Winglet plugin updates the Winglet plugin.** When a newer release exists and the gateway is
  idle, it downloads it, verifies it, swaps it in with the existing staged-restore machinery, and
  restarts. Nobody taps anything.
- **The app updates the app.** About shows the release and starts a download + install. No server
  job, no consent, no stages, no recovery.
- **The app only reads server state.** It displays "server 0.11.0, updated 09:41" from an endpoint.
  It cannot start a server update at all.

## Gates, in order

1. `autoUpdate` setting is on (owner-set, default on). Off means the server only tells you a release
   exists.
2. The release is newer than the running version (semver compare, existing helper).
3. Same major version. A major jump needs an explicit owner action — never unattended.
4. No chat is busy and no job is running (existing idle check, existing bounded wait).
5. The release carries a `plugin` asset whose `sha256` matches the digest GitHub publishes.
6. The zip's `plugin.yaml` version equals the release tag, and its `min_hermes` is satisfied by the
   running Hermes.
7. At most one attempt per release per boot, and never a retry inside 30 minutes after a failure.

## Safety, because nobody is watching

The pieces that already exist and must be reused, not reimplemented: versioned backups that are
never overwritten, the tree digest re-verified before a restore, the staged swap with `os.replace`,
the refusal to repeat an interrupted restore, and the kept copy of the database.

What does not exist yet, and is the whole risk of this change: **a plugin that fails to import cannot
roll itself back.** So the update writes a marker before the swap:

```
~/.hermes/winglet-update.json   { "from": "0.10.11", "to": "0.11.0", "backup": "<path>", "started": <epoch> }
```

and an **out-of-process watchdog** clears it:

- `hermes winglet rollback` — a new CLI command that restores `backup` with the existing
  `update_rollback.restore()` and restarts the gateway.
- A systemd unit + timer (`winglet-update-watchdog`, one-shot at boot + 10 minutes after an update,
  then every 10 minutes for an hour) that reads the marker and, if the plugin has not reported
  health for the new version after 10 minutes, runs the rollback and posts the result to the owner.

Health is reported by the plugin itself: on startup, if the marker names the running version, the
plugin clears it and records "update ok" in the audit log. That is a single write on the happy path,
and its absence is the failure signal.

The watchdog is installed by `hermes winglet setup` and re-installed by any update that changes it.
If systemd is unavailable, the same check runs from the plugin's existing janitor *and* the watchdog
unit is reported as missing on the About screen — silence is not an option.

## What is deleted

- The app's `unifiedUpdate` server stages (`dispatching`, `tracking`, `opened`, `awaiting-app`) and
  the owner-consent text on the update sheet.
- `POST /api/system/update` with `target=winglet` from the phone. Keep `target=hermes` — updating
  Hermes core stays a deliberate, owner-signed action.
- The Server screen's Winglet row, the restart notices, and `forget()` complexity around handoff.
  Keep the stale-offer guard: an offer that is not newer than the running build is still not an offer.

## What must not regress

- An owner can still update by hand, immediately, from the app (that becomes "check now").
- A failed unattended update never leaves the server on a half-installed plugin: marker, watchdog,
  rollback, restart, and a message the owner will see.
- The database is never restored under a running gateway (see REVIEW U1).
- Nothing updates while a chat is replying.

## Order of work

1. Plugin: `autoUpdate` setting, self-check timer, gates, marker, health write, audit entries.
2. Out-of-process: `hermes winglet rollback`, systemd unit + timer, install/uninstall in setup.
3. App: strip the server orchestration; About shows server version and last update; download + install.
4. Release as 0.11.0 — a minor bump precisely because the app/server contract changes.
