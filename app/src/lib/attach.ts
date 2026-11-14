import { Platform } from 'react-native';
import { haptic } from './haptics';
import { preparePhoto, uploadFile, type PickedFile, type UploadHandle } from './media';
import { useApp } from './store';
import type { AttachmentKind, DraftFile } from './types';

// Uploads in flight, so they can be cancelled; and the original picks, so a failure can be retried.
const handles = new Map<string, UploadHandle>();
const originals = new Map<string, { file: PickedFile; keepOriginal: boolean; voice: boolean }>();

function kindFor(mime: string, voice: boolean): AttachmentKind {
  if (voice) return 'voice';
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const newId = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Attach files to a chat's composer and start uploading them straight away, so sending is instant.
 * Voice notes send themselves as soon as their upload finishes.
 */
export function attachFiles(serverId: string, chatId: string, files: PickedFile[], opts: { keepOriginal?: boolean; voice?: boolean } = {}) {
  const { updateDraftFiles } = useApp.getState();
  for (const file of files) {
    const localId = newId();
    const voice = !!opts.voice;
    originals.set(localId, { file, keepOriginal: !!opts.keepOriginal, voice });
    const draft: DraftFile = {
      localId, name: file.name, mime: file.mime, kind: kindFor(file.mime, voice), size: file.size,
      previewUri: file.isImage ? file.uri : undefined, progress: 0, status: 'uploading', autoSend: voice,
    };
    updateDraftFiles(serverId, chatId, (list) => [...list, draft]);
    start(serverId, chatId, localId);
  }
}

function patch(serverId: string, chatId: string, localId: string, change: Partial<DraftFile>) {
  useApp.getState().updateDraftFiles(serverId, chatId, (list) => list.map((f) => (f.localId === localId ? { ...f, ...change } : f)));
}

async function start(serverId: string, chatId: string, localId: string) {
  const server = useApp.getState().servers.find((s) => s.id === serverId);
  const original = originals.get(localId);
  if (!server || !original) return;
  patch(serverId, chatId, localId, { status: 'uploading', progress: 0, error: undefined });
  try {
    const prepared = await preparePhoto(original.file, original.keepOriginal);
    // On the web a recording or pasted file may only exist as a blob: URL.
    if (Platform.OS === 'web' && !prepared.file) prepared.file = await (await fetch(prepared.uri)).blob();
    const handle = uploadFile(server, chatId, prepared, (p) => patch(serverId, chatId, localId, { progress: p }), original.voice ? 'voice' : undefined);
    handles.set(localId, handle);
    const upload = await handle.promise;
    handles.delete(localId);
    patch(serverId, chatId, localId, { status: 'ready', progress: 1, upload, kind: upload.kind, mime: upload.mime, size: upload.size, name: upload.name });
    const draft = useApp.getState().draftFiles[`${serverId}:${chatId}`]?.find((f) => f.localId === localId);
    if (draft?.autoSend) {
      haptic.light();
      useApp.getState().updateDraftFiles(serverId, chatId, (list) => list.filter((f) => f.localId !== localId));
      originals.delete(localId);
      await useApp.getState().sendMessage(serverId, chatId, '', { attachments: [upload] });
    }
  } catch (e) {
    handles.delete(localId);
    const status = (e as { status?: number }).status;
    if (status === -1) return; // cancelled: already removed
    haptic.error();
    patch(serverId, chatId, localId, { status: 'failed', error: (e as Error).message });
  }
}

export function retryFile(serverId: string, chatId: string, localId: string) {
  start(serverId, chatId, localId);
}

export function removeFile(serverId: string, chatId: string, localId: string) {
  handles.get(localId)?.abort();
  handles.delete(localId);
  originals.delete(localId);
  useApp.getState().updateDraftFiles(serverId, chatId, (list) => list.filter((f) => f.localId !== localId));
}

/** Whether the composer can send: some text or a file, and nothing still uploading. */
export function canSend(text: string, files: DraftFile[]): boolean {
  if (files.some((f) => f.status === 'uploading')) return false;
  return !!text.trim() || files.some((f) => f.status === 'ready');
}

/** One submission per composer until outbox admission (or signed-command acceptance). */
const sendingDrafts = new Set<string>();

/** Keep the live draft until accepted/queued; never roll an old snapshot over newer edits. */
export async function sendDraft(serverId: string, chatId: string, text: string, prefix = '') {
  const state = useApp.getState();
  const key = `${serverId}:${chatId}`;
  if (sendingDrafts.has(key)) return false;
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return false;
  const files = (state.draftFiles[key] ?? []).filter((f) => f.status === 'ready' && f.upload);
  const replyTo = state.replyTo[key];
  const body = prefix && text.trim() ? `${prefix} ${text.trim()}` : text.trim();
  if (!body && !files.length) return false;
  let textChanged = (state.drafts[key] ?? '') !== text;
  let replyChanged = false;
  let serverChanged = false;
  // Latch changes, including editing away and back, rather than comparing only at resolution.
  const unsubscribe = useApp.subscribe((next, previous) => {
    textChanged ||= next.drafts[key] !== previous.drafts[key];
    replyChanged ||= next.replyTo[key] !== previous.replyTo[key];
    const target = next.servers.find((s) => s.id === serverId);
    // wsAuth and bot descriptions are refreshed routinely; pairing/address/routing are not.
    serverChanged ||= !target || target.url !== server.url || target.token !== server.token
      || target.deviceId !== server.deviceId || target.profile !== server.profile
      || target.parent !== server.parent || target.addedAt !== server.addedAt;
  });
  sendingDrafts.add(key);
  try {
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => { admitted = resolve; });
    const delivery = state.sendMessage(serverId, chatId, body, {
      attachments: files.map((f) => f.upload!), replyTo, onAdmitted: admitted,
    });
    // Signed commands resolve only after acceptance; ordinary messages belong to the
    // outbox immediately. race observes later delivery rejections without resending.
    await Promise.race([admission, delivery]);
    if (serverChanged) return false;
    const current = useApp.getState();
    if (!textChanged) current.setDraft(serverId, chatId, '');
    if (!replyChanged) current.setReplyTo(serverId, chatId, undefined);
    // A ready file may be immutably refreshed without becoming a different upload.
    // A retry/new upload (or one still uploading) keeps its tray entry and original pick.
    current.updateDraftFiles(serverId, chatId, (list) => list.filter((f) =>
      !files.some((sent) => f.status === 'ready' && f.localId === sent.localId && f.upload?.id === sent.upload!.id)));
    const remaining = useApp.getState().draftFiles[key] ?? [];
    files.forEach((f) => { if (!remaining.some((next) => next.localId === f.localId)) originals.delete(f.localId); });
    return true;
  } catch (error) {
    // Composer awaits admission: prequeue rejection must not sound or look sent.
    if (!serverChanged) useApp.getState().toast({ serverId, title: "Couldn't send",
      body: error instanceof Error && error.message ? error.message : 'Your draft is still here; try again.' });
    return false;
  } finally {
    unsubscribe();
    sendingDrafts.delete(key);
  }
}
