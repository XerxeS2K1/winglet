# Tracked Markdown audit and disposition

## Scope and evidence

- Baseline: `2164445`, before the unified-update correction. All **85 tracked Markdown files** were read from their complete Git blobs by an independent documentation helper.
- Parent cross-check: inventory and per-file entries agree; **20 current, 56 historical, 5 legal, 3 template, 1 generated**.
- The audit found **40 recommendations across 23 files**, including **12 current documents** needing changes. Recommendations include optional historical annotations; they are not 40 code defects.
- Local corrective commits follow this baseline. This report adds one tracked Markdown file; it is not part of the original 85-file denominator.
- GitHub `main` was checked separately and remained `f33a2c1`; local documentation changes are **not published** until an approved push is verified.

## Disposition

Living release/bootstrap status and the rejected auto-update toggle have been corrected. New unified-update behaviour remains explicitly local and unfinished until the final app commit, review and rerun evidence are entered in APP_PLAN. Exact ordering, failure/recovery semantics and UI wording still require reconciliation with that implementation before release. Historical release text is preserved with dated resolution/clarification notes; older design documents link to the current checkpoint. Legal/generated notices are not rewritten.

The audit is documentation evidence, not a code review, web rebuild, runtime check or phone test. No new release, installation or gateway restart is authorized by it.

## Per-file inventory

| File | Classification | Disposition |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/bug_report.md` | template | No update-specific change needed. |
| `.github/ISSUE_TEMPLATE/feature_request.md` | template | No update-specific change needed. |
| `.github/pull_request_template.md` | template | Full-inventory integration gate added. |
| `CONTRIBUTING.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `README.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `SECURITY.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `app/README.md` | current | No update-specific correction identified. |
| `app/vendor/decode-uri-component/README.md` | current | No update-specific correction identified. |
| `docs/APPROVALS.md` | current | No update-specific correction identified. |
| `docs/APP_PLAN.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/BOTS.md` | current | No update-specific correction identified. |
| `docs/DESIGN.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/DEVICE_LINKING.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/FEATURES.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/HERMES_COMPATIBILITY.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/HISTORY.md` | current | No update-specific correction identified. |
| `docs/LOCAL_COMBINED_TEST.md` | historical | Preserve dated history. |
| `docs/MOBILE_EXPERIENCE.md` | historical | Preserve dated history. |
| `docs/RELEASING.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/REMOTE_ACCESS.md` | current | No update-specific correction identified. |
| `docs/SERVER_PLUGIN_UPDATE.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/SETUP.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `docs/STABILITY.md` | historical | Preserve dated history. |
| `docs/THEME_AUDIT.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/advanced-config.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/allow-all-in-chat.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/android-assistant.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/branching.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/checkpoints.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/combined-validation.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/context-insights.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/custom-mcp-and-skills.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/dependency-audit-2026-10.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/encrypted-push.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/event-replay.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/execution.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/live-voice.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/native-review.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/native-speech.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/old-audit-recheck.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/phone-tools.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/processes.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/project-room-refresh.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/projects.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/release-review-v0.10.0.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/rooms-in-projects.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/rooms.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/routine-history.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/smart-approvals.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/third-party-notices.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/transcript-tools.md` | historical | Preserve dated history. |
| `docs/agent-handoffs/wear-os.md` | historical | Preserve dated history. |
| `docs/releases/v0.10.0.md` | historical | Preserve dated history. |
| `docs/releases/v0.10.1.md` | historical | Preserve dated history. |
| `docs/releases/v0.10.2.md` | historical | Preserve dated history. |
| `docs/releases/v0.10.3.md` | historical | Preserve dated history. |
| `docs/releases/v0.10.4.md` | historical | Preserve dated history. |
| `docs/releases/v0.10.5.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/releases/v0.10.6.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/releases/v0.10.7.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/releases/v0.2.0-beta.1.md` | historical | Preserve dated history. |
| `docs/releases/v0.2.0-beta.2.md` | historical | Preserve dated history. |
| `docs/releases/v0.2.0.md` | historical | Preserve dated history. |
| `docs/releases/v0.3.0.md` | historical | Preserve dated history. |
| `docs/releases/v0.4.0.md` | historical | Preserve dated history. |
| `docs/releases/v0.5.0.md` | historical | Preserve dated history. |
| `docs/releases/v0.5.1.md` | historical | Preserve dated history. |
| `docs/releases/v0.6.0.md` | historical | Preserve dated history. |
| `docs/releases/v0.9.0.md` | historical | Preserve dated history. |
| `docs/superpowers/plans/2026-10-15-pets-presence.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/superpowers/plans/2026-10-16-mobile-polish-validation.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/superpowers/plans/2026-10-16-mobile-polish.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/superpowers/specs/2026-10-15-pets-presence-design.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/superpowers/specs/2026-10-16-chat-first-sidebar.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/superpowers/specs/2026-10-16-keyboard-home-refinement.md` | historical | Preserved; historical banner or dated follow-up added. |
| `docs/superpowers/specs/2026-10-16-mobile-polish-design.md` | historical | Preserved; historical banner or dated follow-up added. |
| `plugin/README.md` | current | Current status/contract corrected locally; final implementation alignment pending. |
| `plugin/THIRD_PARTY_NOTICES.md` | generated | Preserve generator output. |
| `scripts/demo/README.md` | current | No update-specific correction identified. |
| `third_party/notices/decode-uri-component.md` | legal | Preserve legal/provenance text. |
| `third_party/notices/herald-execution.md` | legal | Preserve legal/provenance text. |
| `third_party/notices/herald-live-voice.md` | legal | Preserve legal/provenance text. |
| `third_party/notices/unifiedpush-embedded-fcm-distributor.md` | legal | Preserve legal/provenance text. |
| `third_party/notices/unifiedpush.md` | legal | Preserve legal/provenance text. |
| `wear/README.md` | current | No update-specific correction identified. |

## Release follow-through

Before claiming GitHub documentation is current, finish source/docs reconciliation, record actual exact-head verification in APP_PLAN, rebuild and asset/freshness-check the web bundle, publish only with approval, then read the changed remote documents back.
