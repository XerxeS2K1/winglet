import type { McpCatalogEntry, McpServer } from './types';

const LABELS: Record<string, string> = {
  'autonomous ai agents': 'AI agents', mlops: 'MLOps', devops: 'DevOps', mcp: 'MCP', 'smart home': 'Smart home',
};
const ACRONYMS = new Set(['ai', 'api', 'aws', 'crm', 'mcp', 'sql', 'ui']);

/** "software-development" reads "Software development". */
export function categoryLabel(slug: string | null | undefined): string {
  const words = (slug || 'general').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return LABELS[words] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** A catalog slug as a name: "aws-knowledge" reads "AWS Knowledge". */
export function prettyName(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Every word of the query appears somewhere in the fields. */
export function matches(query: string, ...fields: (string | string[] | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fields.flat().filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Items in sections by category, both sorted by name. */
export function byCategory<T extends { name: string; category?: string | null }>(items: T[]): { title: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const title = categoryLabel(item.category);
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([title, list]) => ({ title, items: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Show a link only for an explicit, safe browser URL; otherwise show the identifier. */
export function skillSource(item: { identifier?: string | null; source_url?: string | null; provenance?: string }): { label: string; url: string | null } {
  const value = item.source_url ?? '';
  let url: string | null = null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname && !parsed.username && !parsed.password && !parsed.search) url = value;
  } catch { /* Missing or invalid source URLs are not links. */ }
  return { label: item.identifier || (item.provenance === 'hub' ? 'Installed' : 'Official'), url };
}

/** Where a server lives, in a few words: its host, or the command it runs. */
export function serverPlace(s: { url: string | null; command: string | null; args?: string[] }): string {
  if (s.url) {
    const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(s.url)?.[1];
    return host ?? s.url;
  }
  return [s.command, ...(s.args ?? [])].filter(Boolean).join(' ');
}

/** The keys a catalog entry still needs before it can be added. */
export function missingEnv(entry: Pick<McpCatalogEntry, 'required_env'>, values: Record<string, string>): string[] {
  return entry.required_env.filter((e) => e.required && !(values[e.name] ?? '').trim()).map((e) => e.name);
}

/** A server that signs in on a web page (OAuth) rather than with a key. */
export function signsIn(s: Pick<McpServer, 'transport' | 'auth' | 'source'> & { custom?: boolean }): boolean {
  return !s.custom && s.source !== 'plugin' && s.transport === 'http' && s.auth === 'oauth';
}

/** The first sentence of a description, short enough for a list row. */
export function shortDescription(text: string | null | undefined, max = 110): string {
  const first = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}
