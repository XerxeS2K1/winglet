import { draftKey, useApp } from './store';

/** A local draft slot, never sent to the server as a chat ID. */
export const NEW_CHAT_DRAFT = 'local:new-chat';

/** One shared promise per bot prevents send/model/attachment taps creating duplicate chats. */
export function newChatTarget(serverId: string, resolved: (chatId: string) => void) {
  let id: string | undefined;
  let pending: Promise<string | null> | undefined;
  return (): Promise<string | null> => {
    if (id) return Promise.resolve(id);
    if (pending) return pending;
    pending = (async () => {
      const fail = () => {
        const st = useApp.getState();
        const offline = st.network === false || st.runtime?.[serverId]?.status === 'offline';
        st.toast(offline
          ? { serverId, title: "You're offline", body: "A chat can't be started while offline. Your draft is saved." }
          : { serverId, title: "Couldn't start a chat", body: 'Your draft is saved. Try again when your bot is reachable.' });
        return null;
      };
      try {
        const chat = await useApp.getState().createChat(serverId);
        if (!chat) return fail();
        id = chat.id;
        const st = useApp.getState();
        // Read after creation: typing may have continued while the request was in flight.
        const key = draftKey(serverId, NEW_CHAT_DRAFT);
        const draft = st.drafts[key] ?? '';
        st.setDraft(serverId, chat.id, draft);
        st.setDraft(serverId, NEW_CHAT_DRAFT, '');
        // A landing can also hold ready attachments and a reply target.
        const files = st.draftFiles?.[key] ?? [];
        if (files.length && st.updateDraftFiles) {
          st.updateDraftFiles(serverId, chat.id, () => files);
          st.updateDraftFiles(serverId, NEW_CHAT_DRAFT, () => []);
        }
        const reply = st.replyTo?.[key];
        if (reply && st.setReplyTo) {
          st.setReplyTo(serverId, chat.id, reply);
          st.setReplyTo(serverId, NEW_CHAT_DRAFT, undefined);
        }
        resolved(chat.id);
        return chat.id;
      } catch {
        return fail();
      } finally { pending = undefined; }
    })();
    return pending;
  };
}
