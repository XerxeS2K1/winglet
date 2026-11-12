# More than one bot

Each Hermes profile is a bot, the same as Hermes Desktop's Bots: its own persona, memory, skills, chats
and pet. Keep your main bot for everyday chat and add bots for separate jobs.

## Main bot

The app opens on your main bot (the first one paired, until you pick another under Agent → Main bot).
Home puts that bot up front with its pet and a message box, and keeps your other bots in a small row you
tap to bring forward.

## On the same server, from the phone

"Add a bot" (in the bot switcher, on Home, or under Agent) offers to create a new bot, scan a QR, or pair
with a code from another server. Creating one needs an owner phone and compatible Hermes support. It makes
a new profile the way Hermes Desktop does (your provider keys and model, never your chat-platform tokens)
and it's on the phone at once, with no new port and no pairing. Bots made in Hermes Desktop, with
`hermes profile create`, or by the agent itself show up too.

Hermes serves every profile from the one gateway once there are two of them; after the first new bot,
restart the server once (the app offers to). If you used to run a gateway per profile, fold them into one
first with `hermes gateway migrate --multiplex`.

## Teamwork

Your bots can call on each other. Say "ask Chef what's for dinner" in any chat and your bot asks Chef and
brings back the answer, the way Hermes Desktop's Bot Mode does (the message lands in Chef's "Bot Chat").
Ask your bot to make a new one ("make me a bot that plans meals") and it does, after you approve it like a
risky command. Both tools are in the "bots" toolset under Tools.

A bot that is working on a hand-off shows "Working". Owners can see how many hand-offs are queued behind it and
open a read-only queue sheet showing their order (nothing can be cancelled or reordered from the phone). A hand-off
shows which Winglet chat asked, and a short "finished" note appears in that chat when it is done. The note does not
wake the asking bot. These need a server plugin that matches the app.

A bot also stays "Working" while it has a live tracked background task, such as a build or a test run,
although it has already acknowledged the request. This does not add a hand-off or change the queue count.
The server reports only the number of background tasks and a short reason, never command lines. Missing
or unreadable process records leave the usual activity rule unchanged. Dead or recycled process IDs do
not count. This reads Hermes 0.23's persisted process checkpoint, scoped to the bot's session namespace;
processes inside a sandbox cannot be verified on the host and are not counted.

A bot also shows as "Working" when Hermes has a started hand-off for it and the gateway's live-work check does not
answer. When the gateway does answer, its answer wins, so a started record left behind inside a long-running gateway
cannot keep a bot on "Working". That hand-off, and any queued ones, appear in the queue sheet.

Optionally, if you run a job dispatcher that keeps one `job-*.json` record per job in a folder (the folder named by
`BOT_DISPATCH_HOME`, else `<hermes home>/jobs`), the queue sheet also lists its running and pending stages as
"Job: <stage> - <bot> - attempt N". A running stage makes its bot "Working", even when the bot has queued hand-offs
or a full queue. When the bot already has a started hand-off of its own, the job row is only a detail line (shown as
"Job"), not a second task. A pending stage is listed as a waiting row but is not added to the waiting count and does
not make the bot "Working"; this is deliberate, because the count is Hermes's own queue, not the dispatcher's plan.
Only the newest 50 records (64 KB each, at most 20 stages per job) are read, read-only, and symlinks are not
followed. A record not touched for two hours, or whose newest stage started more than two hours ago, is treated as a
dead dispatcher's and ignored. The folder is read at most once every three seconds while it is unchanged. A missing
folder or a bad file changes nothing.

### The hand-off queue and its titles

When a bot is busy, the hand-offs waiting for it are listed (owner only) in the queue sheet opened from the bot
picker. Each row shows a short title, with the sender and position underneath. Titles are the sender's own words,
shown as plain text:

- A bot that asks another with the `ask_bot` tool passes a short `title` (about 50 characters; longer is cut).
- A hand-off sent some other way, for example with Hermes's own `message_agent`, can start its message with a line
  such as `TITLE: Plan dinner for six`. The words after `TITLE:` become the title.
- With neither, the row shows the first line of the request, cut at about 60 characters at a word boundary.

## On another server

Pair it as usual; it stacks up in the sidebar with the others. A profile can also keep its own gateway
and port:

```bash
hermes -p researcher winglet setup --port 8788
hermes -p researcher gateway run
hermes -p researcher winglet pair
```
