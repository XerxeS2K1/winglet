> **Historical handoff.** This records a past assignment's state and is kept as history. Its
> validation claims, version numbers and file paths may be stale. For current status, gates and
> next actions see [APP_PLAN.md](../APP_PLAN.md).

# Rooms in projects

## Design

A room can be filed in at most one owner-shared project across all bots. The project's bot must participate when the room is filed. If the bot later leaves the roster, the link remains and the project view marks the room with a note. Project membership never grants a room read permission. Moving a room only changes project metadata, not its transcript, roster or upstream Hermes state. Deleting a project removes its links, never its rooms. Archived or deleted rooms do not appear in project views.

“Project into a Room” means starting a new Room from a Project, not merging existing project chats into a shared Room transcript. Hermes owns the room transcript, so merging chats would misrepresent and potentially alter upstream state.

## Contract

The additive `project_rooms` feature flag gates the app's room-in-project controls. Older servers without the flag retain the old rooms and projects behavior. Reads use paired-device authorization and the normal room read-grant checks; writes are owner-signed. The app sends writes using `signedApi`, shows failures and does not enqueue them in an offline outbox.

- `GET /api/project-rooms` lists readable, active filed rooms across bots, including the project id, bot, current project revision and a `bot_missing` indicator. Project visibility and room read grants are both required.
- `POST /api/project-rooms/{room_id}` moves or removes a room. The request carries a `client_id`, destination `project_id` (null for removal), destination `revision`, and the previous `from_project_id` and `from_revision` when applicable. Project revisions and idempotent retry receipts protect concurrent changes.
- `POST /api/rooms` optionally accepts `project_id` and `revision` alongside its normal `operation_id`, title and bots. Creation happens first; the project filing request uses a server-derived `room-file:` plus the operation id. A successful filing returns `filed: true` and normally a project snapshot; if a post-commit snapshot fails, the response retains `filed: true` without the snapshot. If filing fails, the room remains available and the response includes `filed: false` and `file_error`; the app tells the owner and offers the ordinary move flow. Without a project id, room creation retains its existing response.

The room metadata and project links live in separate SQLite databases. A room metadata transaction protects validation of its archive state and roster during a filing write; the project database transaction commits the link, project revisions and retry receipt together. There is no distributed transaction spanning room creation and project filing. A filing failure must therefore never erase or pretend to erase an already-created room. Project reads filter out missing and archived rooms, even when an old link remains. Restoring an archived room can make a retained link visible again. Roster removal retains the link deliberately.

## App

The room settings sheet opens a project picker with an unfiled option. Project views list Rooms separately from chats, indicate a missing project bot, and offer New room for active owner-shared projects. The target project's bot is preselected for creation. A failed create-and-file displays a partial-success message; conflict and network failures do not queue a mutation.

## Validation and limits

The full local plugin suite passed with 698 passed and 32 skipped; the app suite passed 464 tests and TypeScript passed. Web export and the existing bundle-reference check passed. The 14 room-project tests all failed against a detached `origin/dev` worktree without the implementation, then passed with the feature. The local report records all final commands and counts. Pinned-Hermes tests run in CI only; CI and physical-phone validation are deferred to the reviewer. Later phone QA should exercise move/remove and project creation, cross-bot moves, access revocation, archive and restore, roster changes, offline and conflicting writes, old-server compatibility, accessibility, and reconnection.
