# Hermes compatibility

Winglet is a Hermes plugin, and Hermes changes its inner workings between releases. This page says which
Hermes versions this fork is checked against and what stops working on an older one.

## What is checked

| Hermes | How it is checked | Result |
| --- | --- | --- |
| **v0.22.7** (pinned) | The `CI` workflow installs this exact release and runs the whole test suite on every push to `integration/dev-all`. | Green |
| **`main`** (latest) | The `Hermes main check` workflow runs the same suite every Monday, and by hand. | Green when last run |
| v0.22.5 | Ran live on the maintainer's server until the move to v0.22.7. | Worked |
| Older than v0.22.5 | Not tested. | See below |

The pinned version moves forward when a newer release has been tried. Look at `.github/workflows/ci.yml` for
the commit it is on now.

## What needs v0.22.5 or later

| Feature | What it needs | What you see on an older Hermes |
| --- | --- | --- |
| Bots asking each other (`ask_bot`) | Hermes's `tools.bot_live_delivery` | The tool is missing. The log says "ask_bot is off", and the bots screen says bots can't ask each other. |
| Messages from paired phones | The adapter answers Hermes's `reauthorize_native_roles` check | Messages can be refused as `permission_denied` (the fix is in this fork). |
| Approval cards in the inbox | Hermes's `_render_approval_sync` (older: `_approval_notify_sync`) | Both are handled. If neither is found, approvals fall back to typed `/approve`. |

## What turns itself off

Each of these is probed when the server starts. If the part of Hermes it needs is missing, the feature is
reported as off in `/api/info` (`features`), the app hides it, and nothing else breaks.

| Feature (`features` key) | Hermes part it looks for |
| --- | --- |
| `bots`, `bot_teamwork` | Several bot profiles served by one gateway (`profiles_to_serve`, `profiles.create`); `bot_live_delivery` for teamwork |
| `goals` | `hermes_cli.goals` |
| `checkpoints`, `checkpoint_restore` | `tools.checkpoint_manager` (and its `restore`) |
| `sessions` | Session listing and search on the gateway runner |
| Member tool limits | The step that caps a turn's tools. If it is missing, members' messages are refused rather than sent unlimited. |
| Voice | `tools.voice_mode` and `tools.tts_tool` |
| Routine history | `cron.executions` and `hermes_state.SessionDB` |

## If something stops working after a Hermes update

1. Open the server log and look for lines starting `[winglet]`; they say what was turned off and why.
2. Check `.github/workflows/hermes-main.yml` results: if the weekly check is red, upstream Hermes changed
   something and this fork needs a fix.
3. Until then, stay on the last Hermes release the `CI` workflow is pinned to.
