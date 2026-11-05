import { api } from './api';
import type { Server } from './types';

export type Command = { cmd: string; hint: string; args?: string; category?: string; kind?: 'command' | 'skill' };

const cache = new Map<string, { at: number; commands: Command[] }>();
const FRESH_MS = 10 * 60 * 1000;

/** Slash commands this bot's Hermes accepts, including skills; cached for ten minutes. */
export async function loadCommands(server: Server): Promise<Command[]> {
  const hit = cache.get(server.id);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.commands;
  try {
    const data = await api<{ commands: Command[] }>(server, '/api/commands');
    cache.set(server.id, { at: Date.now(), commands: data.commands });
    return data.commands;
  } catch {
    return hit?.commands ?? [];
  }
}

export function cachedCommands(serverId: string): Command[] {
  return cache.get(serverId)?.commands ?? [];
}

/** Commands matching what's typed after the slash, best matches first. */
export function matchCommands(all: Command[], typed: string): Command[] {
  const q = typed.slice(1).toLowerCase();
  const starts = all.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q));
  const contains = q.length > 1 ? all.filter((c) => !starts.includes(c) && (c.cmd.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))) : [];
  return [...starts, ...contains].slice(0, 40);
}

/** Commands that approve something dangerous or switch approvals off. The server only takes these in a signed
 *  request (plugin/hub.py SIGNED_ONLY_COMMANDS), so they're sent that way and never wait in the offline outbox. */
export function needsSignature(text: string): boolean {
  return /^\/(?:approve|yolo|approvals)(?:@[^\s]+)?(?:\s|$)/i.test(text.trim());
}
