import { create } from 'zustand';
import { snapshotOf, type FallbackSnapshot } from './fallbackNotice';

/**
 * What the model button already fetched from `/api/agent?chat=`, shared with the strip above the message box so the
 * app asks the server once. Keyed by `<server>:<chat>`; a chat that is not on a fallback has no slot.
 */
type FallbackState = {
  slots: Record<string, FallbackSnapshot | undefined>;
  publish: (key: string, chat: { model?: string; fallback?: unknown } | null | undefined, arrivedAt: number) => void;
  clear: (key: string) => void;
};

export const useFallback = create<FallbackState>((set) => ({
  slots: {},
  publish: (key, chat, arrivedAt) => set((s) => ({ slots: { ...s.slots, [key]: snapshotOf(chat, arrivedAt) ?? undefined } })),
  clear: (key) => set((s) => (s.slots[key] ? { slots: { ...s.slots, [key]: undefined } } : s)),
}));

// The strip opens the model sheet the same way tapping the chip does: the chip says how, and registers it here.
const openers = new Map<string, () => void>();

/** Called by the composer's model chip. Returns how to take the registration back. */
export function registerModelSheetOpener(key: string, open: () => void): () => void {
  openers.set(key, open);
  return () => { if (openers.get(key) === open) openers.delete(key); };
}

/** False when no chip is there to open it (the strip then does nothing). */
export function openModelSheet(key: string): boolean {
  const open = openers.get(key);
  open?.();
  return !!open;
}
