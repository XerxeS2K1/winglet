package expo.modules.wingletpush

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/**
 * Runs notification actions without opening the app. Approve/Decline sends only the short-lived
 * signature. Reply uses the device token kept in the Keystore-backed push record, never in the
 * notification. A refusal is shown as a short notification instead of being swallowed.
 */
class WingletActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action != ACTION_APPROVE && action != ACTION_DECLINE && action != ACTION_REPLY) return
    val pending = goAsync()
    Thread {
      try {
        run(context, intent, action)
      } finally {
        pending.finish()
      }
    }.start()
  }

  private fun run(context: Context, intent: Intent, action: String) {
    val scope = intent.getStringExtra(EXTRA_SCOPE) ?: return
    val tag = intent.getStringExtra(EXTRA_TAG) ?: ""
    val entry = runCatching { PushStore.read(context, scope) }.getOrNull()
      ?: return fail(context, "Winglet's notification key is missing. Open the app and reconnect.")
    val base = entry.optString("server_url").trimEnd('/')
    if (!base.startsWith("https://") && !base.startsWith("http://"))
      return fail(context, "Winglet doesn't know this server's address. Open the app and try again.")
    val message = when (action) {
      ACTION_APPROVE, ACTION_DECLINE -> {
        val item = intent.getStringExtra(EXTRA_ITEM) ?: return fail(context, "That approval is no longer available.")
        val choice = intent.getStringExtra(EXTRA_CHOICE) ?: return fail(context, "That approval is no longer available.")
        val sig = intent.getStringExtra(EXTRA_SIG) ?: return fail(context, "That approval is no longer available.")
        val body = JSONObject().put("choice", choice).put("sig", sig)
        val result = post("$base/api/inbox/${encode(item)}/respond", null, body)
        if (result.status !in 200..299) refusal(result, true) else null
      }
      else -> {
        val chat = intent.getStringExtra(EXTRA_CHAT) ?: return fail(context, "That chat is no longer available.")
        val text = android.app.RemoteInput.getResultsFromIntent(intent)
          ?.getCharSequence(EXTRA_REPLY)?.toString()?.trim().orEmpty()
        if (text.isBlank()) return fail(context, "Write a reply first.")
        val token = entry.optString("token")
        if (token.isBlank()) return fail(context, "Open Winglet once to finish setting up notifications.")
        val clientId = UUID.randomUUID().toString().replace("-", "")
        val body = JSONObject().put("text", text).put("client_id", clientId)
        var result = post("$base/api/chats/${encode(chat)}/messages", token, body)
        // A server that exposes the older flat message route gets the same idempotent reply.
        if (result.status == 404) result = post("$base/api/messages", token,
          JSONObject().put("chat_id", chat).put("text", text).put("client_id", clientId))
        if (result.status !in 200..299) refusal(result, false) else null
      }
    }
    // The answer reached the server (or was definitely refused): the old notification is stale.
    cancel(context, scope, tag)
    if (message != null) fail(context, message)
  }

  private fun refusal(result: Response, approval: Boolean): String {
    val fromServer = runCatching { JSONObject(result.body).optString("error") }.getOrDefault("")
    if (fromServer.isNotBlank()) return fromServer
    return when (result.status) {
      401, 403 -> if (approval)
        "That approval expired, was already answered, or approval actions are off. Open the card to answer it."
      else "This pairing needs attention. Open Winglet and reconnect."
      404 -> if (approval) "That approval is no longer available." else "That chat is no longer available."
      else -> if (result.status == 0) "Couldn't reach your server. Open Winglet and try again."
      else "Winglet could not send that answer. Open the app and try again."
    }
  }

  private data class Response(val status: Int, val body: String)

  private fun post(url: String, token: String?, body: JSONObject): Response {
    val connection = try { URL(url).openConnection() as HttpURLConnection } catch (_: Exception) { return Response(0, "") }
    return try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 5_000
      connection.readTimeout = 8_000
      connection.instanceFollowRedirects = false
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Accept", "application/json")
      if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
      connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      Response(status, stream?.bufferedReader()?.use { it.readText() }.orEmpty().take(2000))
    } catch (_: Exception) {
      Response(0, "")
    } finally {
      connection.disconnect()
    }
  }

  private fun fail(context: Context, message: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (!manager.areNotificationsEnabled()) return
    PushChannels.ensure(manager)
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val pending = launch?.let { intent ->
      PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val notification = Notification.Builder(context, PushChannels.REPLIES)
      .setSmallIcon(R.drawable.ic_stat_winglet)
      .setColor(0xFF5B4BD6.toInt())
      .setContentTitle("Winglet")
      .setContentText(message)
      .setStyle(Notification.BigTextStyle().bigText(message))
      .setAutoCancel(true)
      .apply { if (pending != null) setContentIntent(pending) }
      .build()
    manager.notify(ERROR_TAG, ERROR_ID, notification)
  }

  private fun cancel(context: Context, scope: String, tag: String) {
    if (tag.isBlank()) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(PushStore.noteTag(scope, tag), 1)
  }

  private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

  private companion object {
    const val ERROR_TAG = "winglet-action-error"
    const val ERROR_ID = 2
  }
}
