# Approval card identity

Every Winglet approval card stores the ID of the exact Hermes request it displays. Tapping a
card resolves only that ID. Command text, queue order, and the number of pending requests never
establish identity.

Positive approvals require an owner device's verified signing key and a fresh signed HTTP request.
The WebSocket cannot approve commands. Owners may still deny without a signature, and older
signed notification links remain deny-only. An unverified owner must scan a fresh owner code before
approving; replacing a verified device key requires both an appropriate code and a request signed
by its current key. Owner picker selections, including slash-command confirmations, also require
signed requests. Typed `/approve` fallback commands also require signed HTTP and are never queued
offline. If a verified device loses its signing key, it must be paired again instead of
replacing that key with a code alone.

Browser Web Push subscriptions are limited to Google FCM, Mozilla, Apple and Windows push service
hosts over HTTPS on the default port. Previously stored browser subscriptions to other hosts are
dropped when delivery is attempted. Encrypted Android push uses the server's configured
ntfy relay, or Google's Web Push host if the owner chose the optional built-in delivery on the phone.

## Smart guardian decisions

When Hermes flags a request as `smart_denied`, the card explains that the Smart guardian blocked
it. Winglet restricts the card to the choices Hermes supplied among **once** and **deny**; it does
not add missing choices. The server also rejects other choices for newly created cards. Normal
approval cards retain their supplied choices. The Tools screen explains that Smart uses a second
model; Winglet does not currently detect whether one is configured.

## Allow everything in one chat

Owners can explicitly confirm **Allow everything in this chat** on an ordinary pending approval. The existing signed response approves that request once and enables Hermes's in-memory session bypass for that chat; it does not change the global approval mode. Smart-denied cards cannot enable it. The chat shows **Approvals off in this chat**, with **Turn back on** and a link to Smart approval settings. Members cannot see or change this control. Servers without the `chat_approval_bypass` capability hide it.

The bypass ends when turned off, when Hermes clears the session, or when the process restarts. Hermes's hardline command blocks and user deny rules still run before the bypass. Enabling and disabling are audited. The request is resolved before the bypass is enabled, so a fast worker may issue one more approval card in the interim; that card still needs an ordinary answer. Approving a command cannot undo work that has already started. Rooms are not supported by this shortcut.

### Server contract

The bypass is Hermes's own per-session one (`tools.approval.enable_session_yolo`, as used by the
gateway `/yolo`); Winglet adds no bypass of its own and no second way to approve.

- **Turning it on** is the ordinary signed answer, `POST /api/inbox/{id}/respond` with
  `{"choice": "once", "allow_all": true, "chat_id": "<the card's chat>"}`. It needs a verified
  owner's fresh signature, like any positive approval. `allow_all` must be a boolean (otherwise 400);
  a member or unsigned request is refused with 403, whatever the card.
- The server refuses it (409, and nothing is approved) unless the card is a pending approval answered
  with `once`, its `smart_denied` is exactly `false`, `chat_id` is present and equals the stored
  card's chat, that chat is an ordinary chat (not a Room or Updates), and the card's stored session
  key equals the key the adapter derives for that chat now (`WingletAdapter._session_key`). The
  session is always the stored card's; the client's `chat_id` is only a required cross-check.
- The bypass is switched on **only after** Hermes accepts the answer for that exact request. Answers
  and turn-offs are serialized: when two phones answer one card, the loser gets 409 and never
  switches the bypass on, and a turn-off never interleaves with a turn-on.
- `GET /api/chats/{chat_id}/approval-bypass` (owner) returns `{"enabled": bool}`, read live from
  Hermes. `DELETE` on the same path (`owner_signed`) turns it off for that chat's session only. Both
  are 404 for Rooms, Updates, unknown chats, or when the bypass is unavailable.
- The audit log records `approval_bypass.on` (with the chat) and every `approval_bypass.off`
  (marked "already off" when nothing changed), next to the usual `approval` entry.
- `features.chat_approval_bypass` is true only when the installed Hermes has all three of
  `is_session_yolo_enabled`, `enable_session_yolo` and `disable_session_yolo`. On older servers the
  app hides the controls and the server refuses `allow_all`.

What Hermes guarantees (checked in its source at the pinned ref): the bypass is an in-memory set of
session keys (`tools.approval._session_yolo`), so it applies to that one session only, is dropped at
a session boundary such as `/new` (`clear_session`), and does not survive a gateway restart. Hermes's
floors (`_floor_block`: the hardline blocklist, runtime self-delete and the owner's deny rules) run
before the bypass is consulted, so those commands are still blocked while it is on.

**The resolve window (fails closed).** Hermes wakes the approved worker inside
`resolve_gateway_approval`, before that call returns to Winglet, and Winglet only then turns the
bypass on. A command the woken worker reaches in that short gap still sees approvals on: it gets an
ordinary card (full choices, not `smart_denied`), which is neither approved silently nor left stuck,
and is answered as usual. The worst case is one extra prompt. Enabling the bypass first and rolling
back on failure would fail open, so Winglet deliberately does not do that, and it does not reach into
Hermes internals to close the gap.

## Compatibility with current Hermes

Current Hermes calls `WingletAdapter.send_exec_approval` synchronously from
`gateway.run_turn_runner.TurnRunner._approval_notify_sync`, then schedules the returned coroutine
on its gateway loop. Hermes 0.22.5 moved the adapter call into `_render_approval_sync`, which
`_approval_notify_sync` delegates to; Winglet accepts either function name as the immediate notifier
frame (`_NOTIFIER_FRAMES` in `plugin/bridge.py`). Its `approval_data` contains the request ID, but the adapter arguments omit it.

Winglet's synchronous wrapper reads the immediate notifier frame at that call. It accepts the ID
only when the module/function, notifier context, adapter instance, chat, and session agree. It
copies the string into a fresh metadata dictionary before returning Hermes' normal coroutine.
It does not retain frames, mutate Hermes, or install process-wide hooks. In particular, reading
the queue after scheduling cannot substitute a different request for the captured one.

At card creation, Winglet checks that the captured ID is still queued for the session and has
not already been claimed by another pending card. Missing, expired, or unsupported identity
returns a failed button send before storing or pushing a card. Hermes then sends its usual typed
`/approve` and `/deny` instructions. A Hermes refactor or a runtime without frame access can
therefore disable cards safely.

An explicitly forwarded `request_id` argument, `ExecApprovalPrompt.request_id`, or
`metadata.approval_request_id` also works. An invalid supplied identity never falls back to
capturing a different one. No Hermes changes are required for the current notifier path.

## Validation

The normal Python suite covers worker-to-loop handoff, concurrent sessions, identical commands,
withdrawn requests and replacements, invalid explicit identity, changed notifier paths, and
unavailable frames. `tests/test_chat_approval_bypass.py` covers "Allow everything in this chat":
policy levels, the feature flag, every refusal, two-phone races and the resolve window.
`tests/test_chat_approval_bypass_hermes.py` runs it against the installed Hermes gate (real session
keys, isolation, turning it off, the hardline floor and the window) and skips without Hermes.

To check the handoff against an unmodified Hermes source checkout, set `HERMES_SOURCE` to its
root and run:

```bash
HERMES_SOURCE=/path/to/hermes-agent pytest tests/test_hermes_approval_handoff.py -q
```

That optional test executes Hermes' actual notifier, prompt dataclass, and base send method with
a worker thread and an event loop. Rendering and surrounding transport dependencies are doubled;
it does not start a model or a complete gateway. It verifies card identity and Hermes' typed
fallback, including command redaction. Without `HERMES_SOURCE`, this test is skipped.
