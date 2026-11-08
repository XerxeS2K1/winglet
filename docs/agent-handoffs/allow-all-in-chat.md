> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# Allow everything in one chat

This shortcut is for normal chats only. An owner confirms it on an ordinary approval card; the current request is approved once and Hermes's session-scoped approval bypass is enabled. The chat displays a warning with **Turn back on** and a link to the Smart approvals settings. Smart-denied requests and Room cards do not offer it. Old servers hide the controls unless they advertise `chat_approval_bypass`.

## Contract and security

The existing signed `POST /api/inbox/{item_id}/respond` accepts `choice: "once"`, `allow_all: true`, and `chat_id`. The authenticated owner and signed request are mandatory. The server checks that the supplied chat ID matches the stored pending approval, that the card is not smart-denied, and that the stored session key agrees with the adapter's key for the stored chat. It resolves the existing approval path, and only the winning successful answer enables the bypass. A stale or mismatched request is refused. `GET /api/chats/{chat_id}/approval-bypass` is owner-only; `DELETE` is owner-signed. State changes are audited. The feature adds no persistent data model or global approval-mode change.

Winglet builds a DM source with the chat ID and passes it to the gateway runner's `_session_key_for_source`; the runner uses its session store's key generation, including the profile namespace. Pinned Hermes's `build_session_key` uses namespace, platform, DM type and chat ID; it omits the sender when a chat ID exists. The resulting key is compared with the stored approval's Hermes session key rather than trusting a client-supplied key. The bypass is Hermes's process-local `enable_session_yolo` state, not a separate Winglet allowlist. Hermes clears it with `clear_session` and on process restart. Its command hardline and configured deny rules are checked before that bypass.

Resolving the approval wakes the Hermes worker before Winglet enables the bypass. This order fails closed: a very fast next command can produce one extra approval card, which remains actionable. It avoids granting bypass if another phone wins or the request expires. A command already approved cannot be undone.

## Backend tests

`tests/test_chat_approval_bypass.py` (plain, 30 tests) covers the route policy levels, the `chat_approval_bypass` flag and bridge detection (all three Hermes functions, some missing, no Hermes at all), turn-on for one chat only with audit, a missing or mismatched `chat_id`, every choice other than `once`, smart-denied or non-boolean `smart_denied` cards, a stored session that is not the chat's current key, Rooms and Updates, an answered card, a request Hermes no longer has, a non-approval card, members, unsigned and unpaired requests, scoped and audited turn-off, two phones (plain answer wins; both ask for the bypass), a turn-off racing a turn-on, and the resolve window: a command arriving while Hermes resolves sees the bypass off, gets a normal card and can still be answered.

Red check: with `plugin/hub.py`, `bridge.py` and `adapter.py` reverted to `HEAD`, 28 of the 30 fail. The two that still pass are negative guards: an answered card, and a request Hermes no longer has. Nine targeted mutations of the hub were each caught: enabling before resolve, enabling when resolve failed, no answer lock, no smart-denied check, optional `chat_id`, no session-key match, any choice, Rooms allowed, and an unaudited turn-off.

`tests/test_chat_approval_bypass_hermes.py` uses the real `WingletAdapter._session_key` and Hermes's own `GatewayRunner._session_key_for_source` (no mocked key). It checks that key equals the key of the source Winglet's inbound path hands Hermes, and that it is distinct per chat and per profile. Then, against the real gate in manual mode, it checks: turn-on approves the request and the next command runs without asking; the hardline `rm -rf /` is still blocked; another chat still asks; turn-off makes the next command ask again; and the resolve window gets a normal card that turning the bypass on does not approve. It skips through `importorskip` where Hermes is not installed, and it has not been run locally.

## Rooms and follow-up

Rooms use their separate hosted-room worker and `approval.respond` RPC, not chat inbox approvals. A Rooms implementation must establish how each task's profile and hosted-room live session alias maps to the exact Hermes approval-context session key, including durable session IDs and compression tips, and verify the mapping rather than guessing from a room title. It must also decide whether concurrent tasks in a Room share a key or should be isolated, serialize approvals and bypass changes against task replacement, session ending, multiple owners, and revocation, and preserve the existing signed Room approval path. None of that is implemented here.

Phone QA should check the confirmation and release behavior, banner and turn-off controls, Smart navigation, concurrent phones, old servers, Smart-denied cards, and Room exclusion. Pinned-Hermes integration tests are intended for CI and were not run locally.
