// Content shared into Winglet from another app (Android's share sheet), on its way into a chat's composer.
import type { PickedFile } from './media';
import type { Chat } from './types';

/** What another app shared, the way the library hands it over. */
export type IncomingShare = {
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string } | null;
  files?: { path: string; mimeType?: string | null; fileName?: string | null; size?: number | null; width?: number | null; height?: number | null }[] | null;
};

export type Shared = { text: string; files: PickedFile[]; dropped: number };

/**
 * Turn a share into composer text and files. A link shared on its own keeps the page title above it;
 * a link inside shared text isn't repeated. Returns null when there's nothing to share.
 */
export function fromShare(share: IncomingShare | null | undefined, maxFiles: number): Shared | null {
  if (!share) return null;
  let text = (share.text ?? '').trim();
  const url = (share.webUrl ?? '').trim();
  if (url && !text.includes(url)) text = text ? `${text}\n${url}` : url;
  const title = (share.meta?.title ?? '').trim();
  if (title && text === url && url) text = `${title}\n${url}`;
  const all = (share.files ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
  const files: PickedFile[] = all.slice(0, maxFiles).map((f, i) => {
    const mime = f.mimeType || 'application/octet-stream';
    return {
      uri: fileUri(f.path), mime, name: f.fileName || defaultName(mime, i),
      ...(f.size ? { size: f.size } : {}), ...(f.width ? { width: f.width } : {}), ...(f.height ? { height: f.height } : {}),
      isImage: mime.startsWith('image/'),
    };
  });
  if (!text && !files.length) return null;
  return { text, files, dropped: Math.max(0, all.length - files.length) };
}

/**
 * The library builds `file://` + the raw cache path, so a name like "Invoice #123.pdf" would be cut at
 * the `#` when Android parses it. Escape the characters a URI gives meaning to; other URIs pass through.
 */
export function fileUri(path: string): string {
  if (!path.startsWith('file://')) return path;
  return 'file://' + path.slice(7).replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function defaultName(mime: string, i: number) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/pdf': 'pdf' }[mime];
  return `shared-${i + 1}${ext ? `.${ext}` : ''}`;
}

/** Shared text goes after anything already typed in that chat, so a draft isn't lost. */
export function mergeDraft(existing: string, shared: string): string {
  if (!shared) return existing;
  return existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${shared}` : shared;
}

/**
 * This device's main chat on a bot. Before the server has said (just after a cold start), a member's own
 * chat is the one named after their device, never the owners' General they can't post in.
 */
export function mainChat(homeChat: string | undefined, chats: Record<string, Chat> | undefined, deviceId: string): string {
  if (homeChat) return homeChat;
  const mine = `m-${deviceId}`;
  return chats?.[mine] ? mine : 'general';
}

/**
 * Where a share can go on one bot: its main chat first, then its other chats, most recent first. Not
 * Reports, and not another member's own chat, which an owner can see but shouldn't post into by accident.
 */
export function shareTargets(chats: Record<string, Chat> | undefined, main: string, deviceId: string,
  limit = 6): { id: string; title: string; main: boolean }[] {
  const list = Object.values(chats ?? {}).filter((c) => c.kind !== 'home' && (!c.owner_device || c.owner_device === deviceId));
  const others = list.filter((c) => c.id !== main).sort((a, b) => b.updated_at - a.updated_at).slice(0, limit)
    .map((c) => ({ id: c.id, title: c.title, main: false }));
  return [{ id: main, title: chats?.[main]?.title ?? 'General', main: true }, ...others];
}
