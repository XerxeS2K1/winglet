package expo.modules.wingletpush

/**
 * Whether the phone itself should skip the system notification because the app is open and
 * connected to that server. Replies, approvals and questions already show up in the open app
 * (message list, sound, banner, inbox badge), so a notification on top would alert twice.
 * Results are not shown that way, so they still notify (silently, on the routine channel).
 */
internal object PushPolicy {
  fun skipWhileOpen(kind: String, serverOnline: Boolean): Boolean =
    serverOnline && (kind == "message" || kind == "approval" || kind == "question")
}
