/** What a server push notification offers, rendered the same way on the phone and in tests. */

export type NotificationNote = {
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
  item_id?: string;
  chat_id?: string;
  choices?: string[];
  sig?: Record<string, string>;
  /** Unix seconds; the server's short-lived shade approval expiry. */
  shade_expires?: number;
};

export type NotificationAction = {
  id: 'approve' | 'decline' | 'reply';
  title: string;
  /** Approval choices only; reply actions use a text input instead. */
  choice?: 'once' | 'deny';
  sig?: string;
  textInput?: boolean;
};

export type NotificationModel = {
  title: string;
  /** The whole command for an approval; never clipped here. */
  body: string;
  actions: NotificationAction[];
};

const CLEAR = 'Winglet';

/** Build the notification people see. The server decides what is offered; this only hides an
 * approval when the phone's switch is off or its short-lived signature has already expired. */
export function notificationModel(note: NotificationNote, options: { shadeApprovals: boolean; now?: number; canAct?: boolean }): NotificationModel {
  const now = options.now ?? Date.now() / 1000;
  const sigs = note.sig ?? {};
  const choices = new Set(note.choices ?? []);
  const actions: NotificationAction[] = [];
  // Mirrors the phone: when previews are off or the phone/app is locked nothing can be acted on,
  // not Approve, not Decline and not Reply, so someone holding the phone cannot answer as the owner.
  const canAct = options.canAct ?? true;
  if (!canAct) {
    // no actions
  } else if (note.kind === 'approval') {
    const live = note.shade_expires === undefined || note.shade_expires > now;
    if (options.shadeApprovals && live && choices.has('once') && sigs.once)
      actions.push({ id: 'approve', title: 'Approve', choice: 'once', sig: sigs.once });
    if (choices.has('deny') && sigs.deny)
      actions.push({ id: 'decline', title: 'Decline', choice: 'deny', sig: sigs.deny });
  } else if (note.chat_id) {
    actions.push({ id: 'reply', title: 'Reply', textInput: true });
  }
  return {
    title: (note.title || CLEAR).trim() || CLEAR,
    // The server already put the full command (and description) in an approval body.
    body: note.body ?? '',
    actions,
  };
}

export type RequestSpec = { method: 'POST'; path: string; body: Record<string, unknown>; headers: Record<string, string> };

/** Approve/decline uses only the short-lived signature, never the device token. */
export function approvalResponseRequest(itemId: string, choice: 'once' | 'deny', sig: string): RequestSpec {
  return {
    method: 'POST',
    path: `/api/inbox/${encodeURIComponent(itemId)}/respond`,
    body: { choice, sig },
    headers: { 'Content-Type': 'application/json' },
  };
}

/** Quick reply is an ordinary authenticated message. `client_id` makes a retry idempotent. */
export function quickReplyRequest(chatId: string, text: string, clientId: string, token: string): RequestSpec {
  return {
    method: 'POST',
    // The server's message route is chat-scoped; the app uses the same path as the composer.
    path: `/api/chats/${encodeURIComponent(chatId)}/messages`,
    body: { text, client_id: clientId },
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
}

/** Older servers expose the flat route; the chat-scoped one is current. */
export function quickReplyFallbackRequest(chatId: string, text: string, clientId: string, token: string): RequestSpec {
  return {
    method: 'POST',
    path: '/api/messages',
    body: { chat_id: chatId, text, client_id: clientId },
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  };
}

export type ActionOutcome = { ok: true } | { ok: false; message: string };

/** A refused action is shown to the person instead of disappearing silently. */
export function actionOutcome(status: number, data?: { error?: string }): ActionOutcome {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403)
    return { ok: false, message: data?.error || 'That approval expired, was already answered, or approval actions are off.' };
  if (status === 409) return { ok: false, message: 'That request was already answered.' };
  if (!status) return { ok: false, message: "Couldn't reach your server. Open Winglet and try again." };
  return { ok: false, message: data?.error || 'Winglet could not send that answer. Open the app and try again.' };
}
