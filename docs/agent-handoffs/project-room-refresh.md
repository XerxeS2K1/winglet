> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# Project room refresh

Gateways advertise `project_rooms_sync` when Room metadata updates send a
`project.sync` event for the linked project's bot. The event uses the existing
per-device project snapshot; it contains no Room title, roster or readers.
The subsequent `/api/project-rooms` read still applies current Room access checks.

Project views reload Room rows on project snapshot replacement, focus, foreground
return, reconnect and role changes. A metadata-only sync may keep every project
revision unchanged, so invalidation uses snapshot identity rather than revision
numbers alone. Late responses from an older effect cannot replace newer rows.
Failed reads offer **Reload rooms**.

Older gateways retain the five-second fallback while the project view is focused
and foregrounded. Upgraded gateways make no idle polling requests. The separate
Rooms conversation and Rooms list polling paths are unchanged.

Local validation: 475 app tests passed; 732 plugin tests passed, 33 skipped;
TypeScript, web export and Android/Hermes bytecode export passed. Bundled web
references were checked. The skipped pinned-Hermes tests require CI; physical
iPhone behavior has not been verified in this change.
