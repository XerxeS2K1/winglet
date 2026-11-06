import type { ServerState } from './store';
import type { ConnectionStatus, Delivery } from './types';

export type ConnKind = 'connecting' | 'online' | 'no-internet' | 'unreachable' | 'recovering' | 'signed-out' |
  'update-app' | 'update-server';

export type ConnView = {
  kind: ConnKind;
  title: string;
  detail: string;
  /** What the banner's button does, if anything. */
  action?: 'retry' | 'pair' | 'about';
  tone: 'ok' | 'info' | 'warn' | 'error';
};

/** One clear sentence about why a bot is or isn't reachable, and the one thing to do about it. */
export function connectionView(network: boolean, rt: ServerState | undefined, bot: string, now = Date.now()): ConnView {
  const status = rt?.status ?? 'connecting';
  if (status === 'unauthorized') {
    return { kind: 'signed-out', tone: 'error', action: 'pair', title: 'Signed out',
      detail: `${bot} no longer recognises this device. It was removed or its sign-in was reset. Pair again to reconnect.` };
  }
  if (rt?.compat === 'update-app') {
    return { kind: 'update-app', tone: 'warn', action: 'about', title: 'Update Winglet',
      detail: `${bot} runs a newer Winglet than this app understands. Install the latest app to keep everything working.` };
  }
  if (rt?.compat === 'update-server') {
    return { kind: 'update-server', tone: 'warn', action: 'about', title: 'Update Winglet on the server',
      detail: `${bot}'s Winglet plugin is too old for this app. On the server, run: hermes plugins update winglet` };
  }
  // An open connection to the server is proof the phone is online, whatever Android last reported.
  if (status === 'online') return { kind: 'online', tone: 'ok', title: 'Online', detail: '' };
  if (!network) {
    return { kind: 'no-internet', tone: 'warn', action: 'retry', title: 'No internet',
      detail: "This phone is offline. Messages you send now are queued and go out when you're back." };
  }
  if (rt?.conn.recovering) {
    return { kind: 'recovering', tone: 'info', action: 'retry', title: `Finding ${bot}'s new address`,
      detail: 'The server restarted and got a new address. This usually takes a few seconds.' };
  }
  if (status === 'offline') {
    const next = rt?.conn.nextRetryAt;
    const secs = next ? Math.max(0, Math.ceil((next - now) / 1000)) : 0;
    return { kind: 'unreachable', tone: 'warn', action: 'retry', title: `Can't reach ${bot}`,
      detail: secs ? `Trying again in ${secs}s. Check that Hermes is running.` : 'Trying again now. Check that Hermes is running.' };
  }
  return { kind: 'connecting', tone: 'info', title: 'Connecting…', detail: '' };
}

/** What kind of address a bot uses, without revealing the address itself. */
export function addressKind(url: string): string {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'unknown'; }
  if (host.endsWith('.trycloudflare.com')) return 'automatic HTTPS (quick tunnel)';
  if (host.endsWith('.ts.net')) return 'Tailscale';
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local')) return 'local network';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return 'IP address';
  return 'custom domain';
}

type ReportInput = {
  bot: string;
  url: string;
  recovery: boolean;
  network: boolean;
  appVersion: string;
  appProtocol: number;
  platform: string;
  rt?: ServerState;
};

/**
 * A plain-text report to paste when asking for help. Deliberately excludes tokens, keys, addresses,
 * chat names and message text: only states, times and versions.
 */
export function diagnosticReport(r: ReportInput, now = Date.now()): string {
  const rt = r.rt;
  const view = connectionView(r.network, rt, r.bot, now);
  const ago = (t: number) => `${Math.round((now - t) / 1000)}s ago`;
  const lines = [
    'Winglet diagnostics',
    `app: ${r.appVersion} (protocol ${r.appProtocol}, ${r.platform})`,
    `server: winglet ${rt?.info?.version || 'unknown'}, hermes ${rt?.info?.hermes_version || 'unknown'}, protocol ${rt?.info?.protocol ?? 'unknown'}`,
    `state: ${view.kind}${rt?.compat ? ` (${rt.compat})` : ''}`,
    `network: ${r.network ? 'online' : 'offline'}`,
    `address: ${addressKind(r.url)}${r.recovery ? ', address recovery enrolled' : ''}`,
    `recovering: ${rt?.conn.recovering ? 'yes' : 'no'}`,
    `last error: ${rt?.conn.lastError ?? 'none'}`,
    `queued messages: ${rt?.outbox.filter((o) => !o.failed).length ?? 0}, failed: ${rt?.outbox.filter((o) => o.failed).length ?? 0}`,
    'history (newest last):',
    ...(rt?.conn.history ?? []).map((h) => `  ${ago(h.t)}  ${h.status}${h.note ? ` (${h.note})` : ''}`),
  ];
  return lines.join('\n');
}

/** "just now", "5 min", "3 h", "2 days": how long ago, or how long for. */
export function span(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** What the server's connection mode means for you, in a sentence. */
export function modeSummary(mode: ConnectionStatus['mode']): { title: string; detail: string } {
  return mode === 'quick'
    ? { title: 'Automatic HTTPS',
      detail: "A free Cloudflare quick tunnel gives the server an HTTPS address with nothing to set up. Cloudflare can see what passes through it, and the address changes whenever the tunnel restarts." }
    : { title: 'Direct',
      detail: 'Phones reach the server at an address you set up: your home network, a VPN like Tailscale, or your own domain.' };
}

/**
 * The tunnel's state as one line, with a tone for its dot. Times are server seconds. Pass `checkedAt` (phone
 * milliseconds) when the status is from before the phone lost the server: then it's only the last known state.
 */
export function tunnelSummary(tunnel: NonNullable<ConnectionStatus['tunnel']>, now = Date.now(),
  checkedAt: number | null = null): { text: string; tone: 'ok' | 'info' | 'warn' | 'unknown' } {
  if (checkedAt !== null) {
    const last = { ready: 'up', starting: 'starting', retrying: 'down' }[tunnel.state];
    const ago = span(now - checkedAt);
    return { tone: 'unknown', text: `Unknown right now. Last known: ${last}, ${ago === 'under a minute' ? 'just now' : `${ago} ago`}` };
  }
  if (tunnel.state === 'ready') return { tone: 'ok', text: `Up for ${span(now - tunnel.since * 1000)}` };
  if (tunnel.state === 'starting') return { tone: 'info', text: 'Starting' };
  const wait = tunnel.retry_at ? Math.ceil(tunnel.retry_at - now / 1000) : 0;
  return { tone: 'warn', text: wait > 0 ? `Down. Trying again in ${wait}s` : 'Down. Trying again now' };
}

/** How the latest delivery went, or null before the first one. */
export function deliverySummary(last: Delivery | null, now = Date.now()): string | null {
  if (!last) return null;
  const ago = span(now - last.at * 1000);
  const when = ago === 'under a minute' ? 'just now' : `${ago} ago`;
  return last.ok ? `Last one went through ${when}` : `Last one didn't go through (${when})`;
}

/**
 * Check an address typed for an existing bot. Returns the cleaned address, or why it can't be used.
 * Pairing's rules: http(s), a host, no sign-in, query or fragment.
 */
export function checkAddress(input: string, current: string): { url: string } | { error: string } {
  let text = input.trim();
  if (!text) return { error: 'Enter an address.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return { error: 'Use an http:// or https:// address.' };
  // Without a scheme: plain http on a home network or a bare IP (as pairing assumes), HTTPS elsewhere.
  if (!/^https?:\/\//i.test(text)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\d+\.\d+\.\d+\.\d+(:|\/|$))|^[^/:]+\.local(:|\/|$)/i.test(text);
    text = `${local ? 'http' : 'https'}://${text}`;
  }
  let parsed: URL;
  try { parsed = new URL(text); } catch { return { error: "That isn't a web address." }; }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return { error: 'Use an http:// or https:// address.' };
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: 'Leave out any sign-in, ? or # parts.' };
  }
  const url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  if (url === current.replace(/\/+$/, '')) return { error: 'This phone already uses that address.' };
  return { url };
}
