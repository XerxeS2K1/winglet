# Features

The [README](../README.md#what-it-does) has the overview. This page lists everything Winglet does.

## Talk to it

- **A chat for every topic.** A main chat plus side chats, each its own Hermes session. Replies stream in
  with Markdown, tables and highlighted code.
- **Start talking in place.** The landing opens quietly; sending reveals the full conversation on the same screen,
  with previous messages and your new exchange. Your bot keeps its conversation context.
- **Keep chats organized.** Pin side chats above recent ones, or archive and restore them from Chats → Archived.
  Pins and archives stay on this device; archiving keeps the conversation and its messages.
- **Find the work that matters.** All, Running and Needs you filters in the sidebar and Chats show active
  conversations and requests, including requests in archived chats. Unsent text, attachments and replies
  appear as draft previews; search finds draft text and attachment names.
- **Photos, files and voice notes**, both ways, with a full-screen viewer. Reply to a message, copy, retry
  or stop a reply, and export a chat.
  Every completed text reply has visible Copy, Reply and More actions below it.
- **Share from any app** on Android: a page, some text, photos or files go to the chat you pick, ready to
  send with a note.
- **Search every chat** and jump straight to the message. Each chat keeps its **files and photos** in one place.
- **A quieter conversation.** Tool progress folds into expandable activity rows, with replies kept in view.
  Long approval commands expand when you need the details. Rename, mute and export use the same menu
  in the chat list and inside a chat.
- **Keep the current task in reach.** A strip above the message box shows the current activity, the plan step in
  hand, or the request waiting for you. Open it for the agent's plan, delegated tasks (nested under the
  one that started them), tool results and how the turn ended; stop the whole task while reading or
  typing. Individual delegated tasks aren't stopped from here. Stop requires a live connection and never
  waits in the offline outbox.
- **Works on a bad connection.** Chats open from the phone's cache, and what you send waits until the
  server is back. Failed sends explain the refusal and offer Retry, Edit or Discard; retries keep the
  same delivery ID. Draft text, finished attachments and reply context survive app restarts.
  On Android, offline chat, inbox, draft and outbox values are encrypted with a device key kept in the
  OS keychain. The web app uses origin-scoped IndexedDB.
- **One screen for the connection.** See how phones reach the server, whether the tunnel is up, and
  whether this phone's notifications are getting through. Moved the server to Tailscale or a new domain?
  Point the Android app at the new address; it only moves once your server has signed that address as
  its own.
- **A one-time battery question (Android).** About 5 seconds after Winglet opens, once paired, unlocked and in the
  foreground outside pairing/scanning, a themed, scrollable sheet explains why it needs to stay connected. Continue
  opens Android's own battery-exemption dialog; that system dialog does not use Winglet's palette. Not now, dismissal,
  Back, lock, backgrounding, navigation or unmount safely cancel the explanation. It is remembered once; the web app
  never shows it.
- **One-step verified pairing.** Scan or paste the whole fingerprint-bearing pairing link. It pairs and verifies the
  server key in one step, and reports the resulting Owner or Member access. An existing pairing is verified rather
  than silently duplicated. Address/code-only access stays visibly limited until verification.
- **Trusted-phone browser sign-in.** An unpaired browser shows a QR and check code. A verified owner phone previews
  the request, compares the code, chooses Member (default) or Owner, confirms, and approves. The browser receives
  its own signing key and verified identity. See [pairing and browser sign-in](DEVICE_LINKING.md).

## It asks, you answer

- **Approvals.** Approve a risky command once, for the session, always, or deny it, from the app or the
  notification.
- **Questions** with one-tap answers, and an **Inbox** for everything waiting on you, across all your bots.
- **Notifications** through Web Push on iPhone and desktop and ntfy on Android, with per-chat mute and
  quiet hours. On Android phones with Google Play services you can instead use built-in Google push,
  which needs no second app; it is never chosen for you. See [SECURITY](../SECURITY.md) for what
  Google can see.

## Your agent

- **Models.** Tap the model name inside the message box to choose a model or thinking level. The same controls appear on the chat landing and in conversations. Search readable model names, see the current choice, or set the default for new chats. Add providers and API keys
  from the phone; keys are encrypted for your server before they leave the phone.
  Star models for quick access in the chat picker, or choose from the last eight successful choices.
  Stars do not change the active model; saved choices only appear for providers offered by that server.
- **A fallback notice.** While Hermes has switched to a fallback model, a strip above the message box shows the reason
  (for example rate limit), the model in use and a countdown to when the main model is tried again, or "next message"
  when there is no cooldown. It disappears on its own, and tapping it opens the model sheet. Needs a server plugin
  that matches the app. The server keeps explicit fallback evidence for that chat after Hermes releases its cached agent;
  it does not infer fallback from a different model name. A pre-agent provider notice reports "provider unavailable"
  without inventing a rate-limit reason or reset time. A countdown, when supplied by Hermes, keeps decreasing after the
  reply finishes. A live primary recovery, a changed chat `/model` override or a new session clears the saved detail;
  it is isolated per profile and chat and is not replayed after a gateway restart.
- **Persona, memory and usage.** Persona edits apply to new chats, not to hand-offs already running. Edit who it is, see and fix what it remembers, and track tokens and cost.
- **A pet.** Give your agent an animated face from the [petdex](https://petdex.dev) or [Codex Pets](https://codex-pets.net) gallery
  (a switch on the Pet screen; Codex Pets are downloaded by the server from that one host only). It waves when
  a reply lands, runs while it works and waits when it needs you, on every phone paired with the bot.
  Its pet and color follow it through Home, chats, the bot switcher and the Inbox; small list avatars stay still.
  Poke it and it waves (three quick pokes and it jumps), hold it and it thinks, drag it and it leans. It takes
  its colors from its own sprite.
  Focusing the landing's message box hides the other dock pages and settles the selected pet onto the box;
  it gives a small hop when you send and stays perched while you chat.
- **Bots helping each other.** When one bot asks another for help (`ask_bot`), the chat shows a short "Asked <bot>"
  line you can tap to read the question and answer. A busy bot shows "Working". Owners also see how many hand-offs
  are queued behind it and can open a read-only queue sheet. A hand-off shows which Winglet chat asked, and a short
  "finished" note appears when it is done, without waking the asking bot. These need a server plugin that matches the app.
- **Your main bot.** Choose one in Agent → Main bot. The app selects it on startup. The chat landing has an
  unboxed pet dock above the message box; both move above the keyboard. Drag between pets without changing your main bot
  or its main conversation. New chat sits to its left with a separate composer for the main bot; the first send starts a fresh topic.
  Add a bot follows your other bots and opens the create/pair options.
  See [more than one bot](BOTS.md).
- **Chat-first navigation.** Open the sidebar from the top-left menu for grouped conversation and workspace controls, pinned and recent conversations, search,
  all chats and archives, Agent and Settings. Inbox is at the top right. Settings → Navigation offers an automatic sidebar,
  a drawer, or a pinned sidebar with a compact rail on phones. Search sits inside the history card; long-press a chat or tap its
  three-dot menu for chat actions. There is no bottom navigation bar.
- **Goals.** Give a chat an outcome and Hermes keeps working on it, turn after turn, until its judge says
  it's done. Add requirements, pause it, and follow its progress in the chat.
- **Skills, tools and MCP servers.** Turn skills on and off, read them, and install Hermes's official ones.
  Pick the tools it can use and how risky commands get approved. Connect other apps from Hermes's list of
  approved MCP servers and sign in to them from the phone.

## Your server

- **Control center.** Processor, memory and disk at a glance. Pause new work, restart, and update Hermes and
  Winglet with progress that carries on across the restart. While a plugin update runs, the sheet cannot be dismissed
  by the backdrop, back button, Escape, or a downward drag; success or failure stays on screen until **Done** is
  pressed. The Server screen keeps a reopenable row for unacknowledged results, and relaunch recovers them from
  device-scoped storage plus the existing server job history. An unconfirmed request never silently starts another
  installation. See [server update safety](SERVER_PLUGIN_UPDATE.md).
- **Schedule.** Routines in plain words ("weekdays at 9am", "every 2h"), with their results in the Updates chat.
- **Logs** from Hermes, with keys and tokens hidden.
- **Sessions:** every conversation your agent has had, in any app or routine. Search what was said and read
  any of them back, with the tools it used.

## Safe by default

- **Owners and members.** Share your agent with someone without sharing your chats or the controls.
- **Verified pairing** from a QR or full link, **trusted-phone browser approval**, **signed owner actions**, an
  **activity log** of who changed what, and an optional **app lock** on Android.

## Looks good everywhere

- A flat, quiet look: light or dark, with dark mode in charcoal (the default), graphite or true black for OLED
  screens, six accent colors including a neutral Mono, short motion and haptics, soft sounds you can turn off,
  and a sidebar layout on tablets and desktop.
- Winglet-owned sheets and input text, placeholder, selection and supported cursor/keyboard props follow the selected
  app theme, not the system scheme unless System is chosen. Android cursor/selection handles and iOS keyboard scheme
  have explicit defaults; caller overrides remain available. Native Share, permission/settings prompts and Android's
  battery exemption remain OS-owned. Camera/photo viewing, QR codes and artwork keep their intentional contrast colours.
  See the [source theme audit](THEME_AUDIT.md) for coverage and untested rendered/device states.
- With more than one bot, chips under the landing's greeting switch between them in one tap.
- Compact chat layout uses smaller text and tighter spacing. Approval cards follow the conversation's text column,
  with a short command preview and the full command available to expand and scroll.
- Message boxes stay above the keyboard, including Android windows that draw edge to edge. Updates has a compact shortcut in Chats.
