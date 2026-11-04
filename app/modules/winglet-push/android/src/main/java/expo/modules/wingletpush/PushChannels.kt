package expo.modules.wingletpush

import android.app.NotificationChannel
import android.app.NotificationManager

/**
 * One Android channel per kind of notification, so each can be tuned in system settings.
 * Android fixes a channel's behaviour once it exists, so these have new ids; the single
 * "Winglet messages" channel they replace is removed (unless the user had blocked it).
 */
internal object PushChannels {
  const val NEEDS_YOU = "winglet-needs-you-v2"
  const val REPLIES = "winglet-replies-v2"
  const val ROUTINE = "winglet-routine-v2"
  const val LEGACY = "winglet-messages-v1"

  /** Approvals and questions block the agent, results are routine, everything else is a reply. */
  fun forKind(kind: String): String = when (kind) {
    "approval", "question" -> NEEDS_YOU
    "result" -> ROUTINE
    else -> REPLIES
  }

  fun ensure(manager: NotificationManager) {
    manager.createNotificationChannel(NotificationChannel(NEEDS_YOU, "Needs you", NotificationManager.IMPORTANCE_HIGH)
      .apply { description = "Approvals and questions the agent is waiting on" })
    manager.createNotificationChannel(NotificationChannel(REPLIES, "Replies", NotificationManager.IMPORTANCE_DEFAULT)
      .apply { description = "Replies in your chats" })
    manager.createNotificationChannel(NotificationChannel(ROUTINE, "Routine", NotificationManager.IMPORTANCE_LOW)
      .apply { description = "Finished scheduled jobs and other routine results" })
    // A channel the user switched off stays, so their choice is not silently undone.
    val legacy = manager.getNotificationChannel(LEGACY)
    if (legacy != null && legacy.importance != NotificationManager.IMPORTANCE_NONE) manager.deleteNotificationChannel(LEGACY)
  }

  fun legacyBlocked(manager: NotificationManager): Boolean =
    manager.getNotificationChannel(LEGACY)?.importance == NotificationManager.IMPORTANCE_NONE
}
