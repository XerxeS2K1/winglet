> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# Smart approvals — Hermes integration handoff

## Contract and changes

- Hermes `approvals.mode: smart` assesses flagged commands with the auxiliary `approval` task. An APPROVE grants the individual command; DENY permits an interactive owner to override only once or deny; an error or unrecognized response escalates to a normal human approval.
- Winglet's chat approval adapter preserves `smart_denied` and limits its supplied choices to `once` and `deny`. The existing hub validates those choices and requires a verified owner's signed request for a positive approval. No approval bypass, route, policy level, or storage schema was added.
- `tests/test_smart_approvals_hermes.py` exercises the real Hermes command gate, gateway notifier, queue and base adapter together with the Winglet adapter, hub, Inbox and signed HTTP response. Only the auxiliary inference call is stubbed; the flagged command is never executed. It covers approval, Smart denial and signed one-time override, model error and garbage escalation, and manual mode. These tests use `pytest.importorskip`, so the CI job with pinned Hermes runs them and the plain job skips the module.

## Model resolution decision

No `smart_model_configured` field or warning was added. In the examined Hermes source, `agent.auxiliary_client._resolve_task_provider_model` defaults to `auto`; `_resolve_auto_route` can inherit the main provider/model, use task or main fallback chains, or discover providers and credentials. Credential scope, environment, OAuth and runtime availability matter, so absence of an `auxiliary.approval` model in config does not reliably mean there is no model. If no client can be resolved, `_resolve_call_client` raises `AuxiliaryClientUnavailable`; `_smart_approve` catches failures and escalates to the normal human path. This is a source-level finding, not a live-provider test.

## Rooms decision

No Room integration test was added. Room tasks share Hermes's command gate, but their hosted execution and approval UI are not the Winglet chat notifier/Inbox path: `HostedRoomServerRPC` submits an in-process `prompt.submit`, polls the session's pending approval through `info`, and resolves it using `approval.respond`; `HostedRoomRuntime._report_pending_action` publishes the Room action and `HostedRoomService.approve_room_task` validates room/task/generation/request identity and accepts only `once` or `deny`. Winglet's `Rooms._driver` exposes the action, and `Rooms.mutate` delegates to that service. A meaningful end-to-end Smart denial test would require an active hosted agent session and its server request/transport plumbing, not merely calling the chat adapter or fabricating a pending action. It was not practical to validate that setup without running Hermes locally. Room Smart-denial behavior remains unverified.

## Validation and limits

The plain Winglet plugin suite passed locally with 668 passed and 32 skipped, including the new Hermes-only module skip. The bundled-web reference check found 28 references and no missing assets. App typecheck and web export passed; the app suite passed 457 tests. This change does not modify the app.

**Pinned Hermes execution is not yet verified.** The new integration tests were written against a nearby Hermes source checkout, not run locally, and still require the CI job to pass against ref `47676981f55de91231fdeef2f0eec47e7c209e78`. Thus the test assertions describe intended coverage, not observed proof yet. No real model, provider credentials, timeout, actual shell execution, hosted Room round trip, or physical phone interaction was exercised. The test only proves a gate decision, not that a terminal runs the command. CI and a real-device/provider check remain necessary before claiming end-to-end verification.
