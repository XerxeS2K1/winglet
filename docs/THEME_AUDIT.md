# Selected-theme source audit

Scope: `fix/theme-consistency-2026-11-07`, based on exact combined snapshot `b33ad751b532e6980e12c451a5466dc2802d9420`. The six integrated features and version 0.10.4 are retained. This is a SOURCE audit and component-harness verification, not an all-route visual pass.

## Evidence and limits

The TypeScript AST inventory reads every `.ts`/`.tsx` under `app/src`, including multiline JSX, raw and animated Text, forms, control props, modal/sheet uses, and colour literals. It is not a renderer or a proof that every expression resolves to a correct computed colour. Follow-up inspection traced flagged text styles, dynamic status colours, shared wrappers and route aliases. The full machine inventory and executable scanner are retained under `/root/Code/winglet-plans/theme-2026-11-07-logs/` (`source-inventory.json`, `inventory-tool.cjs`). These are source inputs, not captured phone/user data.

Every rendered route/state below is UNTESTED in a browser/device in this job. A source scan is not visual proof. The parent is responsible for an independent rendered web matrix with verified computed colours; previous unverified light/dark scans must not be reused. Native Android/iOS keyboard/selection rendering, permission/share/settings dialogs, OS battery exemption, gestures, font scaling, actual long-copy layout, status/navigation bars and live server flows remain UNTESTED. No Android APK or phone action is part of this work.

Inventory counts (occurrences include both wrapper calls and primitive implementations):

- source_files: 229
- route_layout_files: 45
- text_sites: 721
- input_sites: 8
- overlay_sites: 98
- overlay_files: 55
- switch_sites: 1
- spinner_sites: 34
- refresh_sites: 1

## Fixes and decisions

- BatteryPrompt: app explanation and Continue/Not now are now the existing selected-theme, scrollable Sheet and SheetAction rows. Android's subsequent exemption dialog remains OS-owned. The lifecycle repair preserves the original Android-only, paired/unlocked/foreground, not-pair-or-scan and five-second defer rules; cancels the question once on Back/dismiss/lock/background/navigation/unmount; rechecks live eligibility before the native request. Once-only storage and askAboutBatteryOnce remain the flow. No force route or debug flag was added.
- TextInput: all eight actual call sites use ThemedTextInput, preserving native instance refs, handlers, secure entry, autocomplete, multiline, accessibility, read-only selection and explicit caller overrides. Defaults are selected-theme text/placeholder/selection, Android cursor and selection handles, and iOS keyboardAppearance. No unsupported keyboardAppearance default is forwarded to Android/web; there is no Android keyboard theme API here. Installed React Native typings distinguish these platform props. The original absent props were a source gap, not a phone-reproduced defect.
- DevicesScreen: defensive no-server return now uses the shared themed Footnote, adding no hook. Normal exported route is already intercepted by withSelectedServer's themed Connect a bot state. The defensive branch is still safe if reached after state changes.
- All source Text without a direct style is in Markdown.renderInline: line breaks, text, escapes and fallback spans inherit their surrounding themed Text. Italic/strike spans intentionally do the same. Dynamic navigation detail, inbox status, task state and routine outcomes use explicit token-derived shorthand `{ color }`; these were inspected, not mechanically recoloured.
- Switch: the single Toggle primitive has token-derived off/on tracks and an intentionally white contrasting thumb. Spinner sites all set a colour, including token-derived status variables; the camera spinner intentionally uses fixed white over its dark viewfinder scrim. RefreshControl has selected-theme tint, Android spinner colours and progress background. iOS switch background/OS variations are device candidates, not established defects.
- Sheet: themed bg/overlay/borders/text, constrained max height, scrolling and lock suppression. CheckpointSheet has a separate token-themed Modal/backdrop with preview/loading/error/confirm/running/result states. MediaViewer's black backdrop and white controls are an intentional photo-viewing exception; not general app chrome. Navigation drawer, lock, toasts, banners and their states use theme tokens.
- Native Share, platform permission prompts, biometric unlock, app/settings screens, attachment pickers, audio/camera permission dialogs and battery exemption are system-owned. Winglet-owned explanations before them are themed; the OS UI cannot be restyled with Winglet's palette.
- ThemeProvider is the sole system colour-scheme reader. It resolves explicit light/dark separately from system mode, includes dark tone and all six accents, updates root/browser background and colour-scheme/meta theme colour, and provides the existing status/nav-bar semantics. Expo NavigationBar dark/light semantics were not inverted. Launch background, manifest/install icon/splash and branding assets are startup/branding exceptions, not palette bugs. Pet colour mixing, avatars, bot identity colours, QR black/white and media are intentional exceptions. No palette or global redesign was needed.

## Harness/state fixtures

- BatteryPrompt actual component: delayed start, once-only flow, Continue and duplicate/stale actions; Not now, Back/onClose, onDismiss, lock, foreground loss, native background event, pair/scan and other navigation, unpair and unmount; storage deferred across lock; immediate background after Continue before its promise continuation; unsupported iOS/web. Body palette is checked across light/dark × three tones × six accents (light-tone repetitions intentional). Backdrop/action palette is exercised through the real shared Sheet harness, not a string stub alone.
- ThemedTextInput actual wrapper: light/dark × three tones × six accents × Android/iOS/web defaults, explicit override precedence, stable ref and handler identity, security/autocomplete/multiline/accessibility/read-only props. AST regression scanner rejects raw native inputs (including aliases/namespaces) and app-owned native Alert calls throughout source. Existing component/input behavior tests remain in the full suite.
- DevicesScreen actual component with defensive no-server fixture and paired fixture: Footnote output and equal hook counts. The withSelectedServer interception is source inspected, not claimed as a rendered route exercise.
- ThemeProvider actual component: light/dark/system × opposite/current system light/dark × three tones × six accents; resolved palette and status/navigation/background props. This is a stubbed API harness, not native chrome rendering.
- Sheet/SheetAction actual components: palette across light/dark/tones/accents at 320×480, 320×240 and 1000×800, long explanatory copy/action labels, scroll container, bounded max height, wrapping/no fixed action height, close handler and lock suppression. This inspects component props/style constraints; it cannot prove actual pixel layout or gesture/animation behavior.
- Existing theme contrast tests exercise token pairs at WCAG AA 4.5:1, including alpha composition, every accent and dark tone. They are not an end-to-end contrast certification for every screen/image/state.

The new Devices/input/battery regression cases were observed failing before their repairs (logs retained). Provider/Sheet harness checks are additional existing-invariant coverage and passed on first run; they are not described as newly failing regression cases.

## Route/layout source inventory

All entries: source inspected; rendered route/state = UNTESTED. `Text`, input and overlay counts refer to direct JSX only; shared component calls and delegated feature screens are not absence of UI. Empty/loading/error/disabled/destructive paths were included in the source search and shared component trace, but not all constructed in a harness.

| Source under app/src/app | Direct Text / input / overlay occurrences | Source/state scope |
|---|---|---|
| `(tabs)/_layout.tsx` | 0 / 0 / 0 | Tab wrapper/layout; selected background |
| `(tabs)/agent.tsx` | 2 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `(tabs)/chats.tsx` | 13 / 1 / 1 | Screen content/conditional states and shared themed primitives; source only |
| `(tabs)/inbox.tsx` | 0 / 0 / 0 | Delegates InboxView request/empty/error states |
| `(tabs)/index.tsx` | 0 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `_layout.tsx` | 0 / 0 / 3 | Startup/root, stack presentations, battery/update/verify/phone requests, lock and toasts |
| `about.tsx` | 14 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `activity.tsx` | 1 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `advanced-config.tsx` | 8 / 2 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `appearance.tsx` | 8 / 0 / 0 | Theme/system, dark-tone and six-accent selection controls |
| `assistant-settings.tsx` | 1 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `assistant.tsx` | 5 / 1 / 1 | Screen content/conditional states and shared themed primitives; source only |
| `bots.tsx` | 3 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `chat/[serverId]/[chatId].tsx` | 0 / 0 / 0 | Delegates shared ChatView / chat content and overlays |
| `checkpoints.tsx` | 0 / 0 / 0 | Delegates CheckpointsScreen and CheckpointSheet states |
| `connection/[serverId].tsx` | 7 / 1 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `devices.tsx` | 15 / 2 / 4 | Defensive empty + pairing/verification, list/error/loading; rename/role/remove/add sheets |
| `logs.tsx` | 5 / 1 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `mcp.tsx` | 18 / 9 / 7 | Screen content/conditional states and shared themed primitives; source only |
| `memory.tsx` | 4 / 1 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `model.tsx` | 3 / 2 / 1 | Screen content/conditional states and shared themed primitives; source only |
| `new-bot.tsx` | 8 / 3 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `notifications.tsx` | 12 / 0 / 1 | Screen content/conditional states and shared themed primitives; source only |
| `open-source-notices.tsx` | 2 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `pair.tsx` | 10 / 3 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `persona.tsx` | 2 / 1 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `pets.tsx` | 13 / 1 / 3 | Screen content/conditional states and shared themed primitives; source only |
| `phone-tools.tsx` | 6 / 1 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `project/[serverId]/[projectId].tsx` | 20 / 1 / 4 | Screen content/conditional states and shared themed primitives; source only |
| `projects.tsx` | 6 / 1 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `providers.tsx` | 2 / 1 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `rooms.tsx` | 0 / 0 / 0 | Delegates RoomsScreen room/project picker, composer and sheets |
| `routine/[serverId]/[routineId]/index.tsx` | 0 / 0 / 0 | Delegates RoutinePage edit/history states |
| `routine/[serverId]/[routineId]/run/[runId].tsx` | 0 / 0 / 0 | Delegates RunPage recorded result/error states |
| `scan.tsx` | 3 / 0 / 0 | App permission explanation themed; fixed dark camera/media overlay and pairing/error states |
| `schedule.tsx` | 8 / 3 / 2 | Screen content/conditional states and shared themed primitives; source only |
| `server.tsx` | 10 / 0 / 3 | Screen content/conditional states and shared themed primitives; source only |
| `session/[id].tsx` | 9 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `sessions.tsx` | 9 / 1 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `settings.tsx` | 3 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `share.tsx` | 5 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `skills.tsx` | 7 / 1 / 3 | Screen content/conditional states and shared themed primitives; source only |
| `tools.tsx` | 4 / 0 / 1 | Screen content/conditional states and shared themed primitives; source only |
| `usage.tsx` | 10 / 0 / 0 | Screen content/conditional states and shared themed primitives; source only |
| `wear-settings.tsx` | 0 / 0 / 0 | Delegates wearable settings and removal sheet |

## Every actual TextInput site

The native implementation occurs only in `components/ThemedTextInput.tsx`; these are its eight application call sites. Field is also used by many forms: all those instances go through the migrated shared Field implementation, not eight total visible form fields.

| Source under app/src | Site / preserved purpose | Rendered state |
|---|---|---|
| `app/new-bot.tsx:128` | `value={purpose} onChangeText={setPurpose} multiline placeholder="Plans meals and keeps the shopping ` | UNTESTED; wrapper prop harness only |
| `app/persona.tsx:60` | `value={text} onChangeText={setText} editable={!busy} multiline textAlignVertical="top" maxLength={MA` | UNTESTED; wrapper prop harness only |
| `components/Composer.tsx:258` | `ref={input} value={text} onFocus={() => onFocusChange?.(true)} onBlur={() => onFocusChange?.(false)}` | UNTESTED; wrapper prop harness only |
| `components/PickerCard.tsx:168` | `value={query} onChangeText={setQuery} placeholder="Find a model" placeholderTextColor={t.colors.text` | UNTESTED; wrapper prop harness only |
| `components/ui.tsx:277` | `placeholderTextColor={t.colors.textTertiary} accessibilityLabel={label} {...rest} onFocus={(e) => { ` | UNTESTED; wrapper prop harness only |
| `components/ui.tsx:367` | `value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={t.colors.t` | UNTESTED; wrapper prop harness only |
| `features/rooms/RoomsScreen.tsx:170` | `accessibilityLabel="Message this room" placeholder="Ask @main and @ops…" placeholderTextColor={t.col` | UNTESTED; wrapper prop harness only |
| `features/transcript-tools/SourceSelection.tsx:7` | `value={text} readOnly multiline showSoftInputOnFocus={false} accessibilityLabel="Original reply, sel` | UNTESTED; wrapper prop harness only |

## Every sheet/modal/overlay source site

This AST list includes local sheet components, their shared Sheet/Modal implementation and visible-prop overlays, so the same surface can appear at both call and implementation sites. Shared drawer/lock/toasts are also inspected separately below. Every rendered state is UNTESTED; only the named component harness fixtures above were executed.

| Source under app/src | JSX overlay sites (line) |
|---|---|
| `app/(tabs)/chats.tsx` | ChatMenu:197 |
| `app/_layout.tsx` | VerifySheet:130, PhoneRequestSheet:131, LockScreen:133 |
| `app/advanced-config.tsx` | Sheet:107, Sheet:123 |
| `app/assistant.tsx` | Sheet:108 |
| `app/connection/[serverId].tsx` | MoveSheet:196, Sheet:300 |
| `app/devices.tsx` | DeviceSheet:94, AddDeviceSheet:95, Sheet:213, Sheet:284 |
| `app/mcp.tsx` | ServerSheet:129, CustomSheet:130, AddSheet:133, JobSheet:145, Sheet:226, Sheet:330, Sheet:405 |
| `app/memory.tsx` | EditSheet:48, Sheet:114 |
| `app/model.tsx` | Sheet:117 |
| `app/new-bot.tsx` | JobSheet:143, JobSheet:144 |
| `app/notifications.tsx` | Sheet:97 |
| `app/pets.tsx` | PetSheet:228, JobSheet:230, Sheet:273 |
| `app/project/[serverId]/[projectId].tsx` | ChatMenu:247, ProjectMenuSheet:248, ChatMenu:262, ProjectMenuSheet:263 |
| `app/projects.tsx` | ProjectCreateSheet:108, ProjectMenuSheet:110 |
| `app/providers.tsx` | KeySheet:78, Sheet:133 |
| `app/schedule.tsx` | EditSheet:101, Sheet:229 |
| `app/server.tsx` | ConfirmSheet:180, JobSheet:181, Sheet:290 |
| `app/skills.tsx` | SkillSheet:126, JobSheet:130, Sheet:180 |
| `app/tools.tsx` | Sheet:123 |
| `components/AddBot.tsx` | Sheet:51 |
| `components/AppNavigation.tsx` | SidebarDrawer:74 |
| `components/AppUpdate.tsx` | Sheet:48 |
| `components/BatteryPrompt.tsx` | Sheet:78 |
| `components/BotSwitcher.tsx` | Sheet:27, QueueSheet:65 |
| `components/ChatMenu.tsx` | Sheet:80 |
| `components/ChatView.tsx` | ChatMenu:278, GoalSheet:285, ContextSheet:286, ProcessesSheet:287, FilesSheet:289, QuoteSheet:295, BranchSheet:301, Sheet:303, Sheet:902 |
| `components/Composer.tsx` | Sheet:307 |
| `components/FilesSheet.tsx` | Sheet:44 |
| `components/Goal.tsx` | Sheet:120 |
| `components/InboxCards.tsx` | Sheet:150, Sheet:160 |
| `components/JobSheet.tsx` | Sheet:76 |
| `components/ManageBot.tsx` | Sheet:66, Sheet:74 |
| `components/MediaViewer.tsx` | Modal:53 |
| `components/ModelSheet.tsx` | ModelSheet:97, Sheet:200 |
| `components/QueueSheet.tsx` | Sheet:14 |
| `components/QuickAsk.tsx` | Sheet:16 |
| `components/Sheet.tsx` | Modal:71 |
| `components/TaskProgress.tsx` | Sheet:127 |
| `components/VerifyPhone.tsx` | Sheet:53 |
| `features/branching/BranchSheet.tsx` | Sheet:116 |
| `features/branching/BranchStrip.tsx` | Sheet:61 |
| `features/checkpoints/CheckpointSheet.tsx` | Modal:136 |
| `features/checkpoints/CheckpointsScreen.tsx` | CheckpointSheet:148 |
| `features/context-insights/ContextSheet.tsx` | Sheet:56 |
| `features/encrypted-push/Settings.tsx` | Sheet:143, Sheet:148 |
| `features/live-voice/VoicePanel.tsx` | Sheet:77 |
| `features/phone-tools/RequestSheet.tsx` | Sheet:20 |
| `features/processes/ProcessesSheet.tsx` | Sheet:115 |
| `features/projects/ProjectSection.tsx` | ProjectCreateSheet:96, ProjectMenuSheet:98 |
| `features/projects/ProjectSheets.tsx` | Sheet:51, Sheet:109 |
| `features/rooms/RoomProjectPicker.tsx` | Sheet:44 |
| `features/rooms/RoomsScreen.tsx` | Sheet:175, Sheet:205 |
| `features/routine-history/RoutinePages.tsx` | EditSheet:113 |
| `features/transcript-tools/QuoteSheet.tsx` | Sheet:62 |
| `features/wear/Settings.tsx` | Sheet:112 |

Additional shared surfaces traced: AppNavigation's SidebarDrawer/history/rail/backdrop, NavigationHeader, Screen/Glass/Card/ListGroup/Footnote/LoadError/Skeleton, LockScreen, Toasts, InboxView and InboxCards approvals/questions, ConnectionBanner, PausedBanner, FallbackStrip, SyncStatus, TaskProgress/TaskDetail, Markdown/code, MediaViewer/MessageAttachments and QR. Artwork-only Logo/BotAvatar/AgentFace/pets are classified above. No route/state visual pass is inferred from these shared components.

## Controls inventory

All primitive spinner/switch/refresh uses are listed below. Dynamic `tint`, `fg` and `color` values were traced to selected-theme tokens, rather than flagged merely for lacking a literal `t.colors` prop.

| Source under app/src | Control sites (line) |
|---|---|
| `app/logs.tsx` | ActivityIndicator:56 |
| `app/mcp.tsx` | ActivityIndicator:237 |
| `app/model.tsx` | ActivityIndicator:107 |
| `app/pets.tsx` | ActivityIndicator:292 |
| `app/scan.tsx` | ActivityIndicator:75 |
| `app/schedule.tsx` | ActivityIndicator:240 |
| `app/skills.tsx` | ActivityIndicator:191 |
| `components/ChatView.tsx` | ActivityIndicator:532, ActivityIndicator:573 |
| `components/Composer.tsx` | ActivityIndicator:255, ActivityIndicator:296 |
| `components/ConnectionBanner.tsx` | ActivityIndicator:41 |
| `components/FilesSheet.tsx` | ActivityIndicator:48 |
| `components/JobSheet.tsx` | ActivityIndicator:80 |
| `components/PausedBanner.tsx` | ActivityIndicator:52 |
| `components/PickerCard.tsx` | ActivityIndicator:86, ActivityIndicator:201, ActivityIndicator:247 |
| `components/Screen.tsx` | RefreshControl:60 |
| `components/TaskProgress.tsx` | ActivityIndicator:111, ActivityIndicator:119 |
| `components/ui.tsx` | ActivityIndicator:83, Switch:207 |
| `features/checkpoints/CheckpointSheet.tsx` | ActivityIndicator:160, ActivityIndicator:180 |
| `features/checkpoints/CheckpointsScreen.tsx` | ActivityIndicator:114, ActivityIndicator:137 |
| `features/context-insights/ContextSheet.tsx` | ActivityIndicator:61 |
| `features/event-replay/SyncStatus.tsx` | ActivityIndicator:43 |
| `features/execution/TaskDetail.tsx` | ActivityIndicator:36, ActivityIndicator:67, ActivityIndicator:82, ActivityIndicator:94 |
| `features/processes/ProcessesSheet.tsx` | ActivityIndicator:159 |
| `features/rooms/RoomsScreen.tsx` | ActivityIndicator:66, ActivityIndicator:137 |

Exact commands, test results, artifact paths and open verification gaps are recorded in `/root/Code/winglet-plans/theme-2026-11-07-report.md`.
