import type { BotActivity } from './types';

/** Human-readable work state, separate from inbox approvals and connection failures. */
export function botActivityLabel(activity?: BotActivity): string {
  if (!activity) return 'Online'; // older server
  const queued = typeof activity.queued === 'number' && Number.isFinite(activity.queued)
    ? Math.max(0, Math.floor(activity.queued)) : 0;
  if (activity.state === 'unknown') return `Activity unavailable${queued ? `, ${queued} queued` : ''}`;
  if (activity.state === 'working') return `Working${queued ? `, ${queued} queued` : ''}`;
  return queued ? `${queued} queued` : 'Online';
}

/** The expandable hand-off row must not label a queued task as answered. */
export function handoffAnswerLabel(asked: { bot: string; state?: string; failed?: boolean }): string {
  if (asked.state === 'queued') return 'Queued; the answer will appear here';
  return asked.failed ? 'No answer' : `${asked.bot} answered`;
}

/** Unknown details are not an empty queue; sort a copy so socket snapshots stay immutable. */
export function botQueueRows(activity?: BotActivity): { id: string; title: string; subtitle: string; value: string }[] | undefined {
  if (!Array.isArray(activity?.queue)) return undefined;
  return [...activity.queue].sort((a, b) => a.sequence - b.sequence).map((item, i) => ({
    id: item.id, title: `${i + 1}. ${item.from || 'Unknown sender'}`, subtitle: item.preview,
    value: item.status === 'started' ? activity.state === 'working' ? 'Running' : 'Started (unconfirmed)' : 'Queued',
  }));
}

/** A bot's short name (its Hermes profile name) from what it's called: "Meal Planner!" reads "meal-planner". */
export function botName(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/**
 * Which bot is the main one: the one chosen, if it's still paired, else the first bot paired on its own
 * (not one made on another bot's server), else the first of all. The rest are secondary bots.
 */
export function resolveMainBot<T extends { id: string; parent?: string }>(servers: readonly T[], chosen?: string): T | undefined {
  return servers.find((x) => x.id === chosen) ?? servers.find((x) => !x.parent) ?? servers[0];
}

/** The main bot first, then the others in the order they were paired. */
export function mainFirst<T extends { id: string; parent?: string }>(servers: readonly T[], chosen?: string): T[] {
  const main = resolveMainBot(servers, chosen);
  return main ? [main, ...servers.filter((x) => x !== main)] : [];
}

/** What a bot's row says while its server is up but Hermes isn't running that bot, else null (also when unknown). */
export function notRunning(bot: { served?: boolean }): string | null {
  return bot.served === false ? 'Not running' : null;
}

/** True when a server with more than one bot says its bots can't ask each other (its Hermes lacks the delivery step).
 *  Only an explicit `false` counts: an older server that doesn't report it is left alone. */
export function teamworkOff(servers: { id: string }[], infos: Record<string, { features?: Record<string, boolean> } | undefined>): boolean {
  return servers.length > 1 && servers.some((x) => infos[x.id]?.features?.bot_teamwork === false);
}
