import { ed25519 } from '@noble/curves/ed25519.js';
import { fetchInfo, hasSigningKey, normalizeUrl, request, serverKey, signedApi } from './api';
import { b64d, b64e, newSigningKey, seal, type ServerKeyInfo } from './crypto';
import { setItem } from './storage';
import type { Bot, Me, Role, Server } from './types';

export type BrowserLinkState = {
  phase: 'idle' | 'creating' | 'waiting' | 'expired' | 'denied' | 'error' | 'unsupported' | 'saving' | 'save-error' | 'paired';
  qr?: string; code?: string; expiresAt?: number; error?: string; role?: Role;
};
type Created = { id: string; poll_token: string; verification_code: string; expires_at: number; fingerprint: string };
type Claimed = { status: 'paired'; token: string; device: { id: string }; me: Me; server_id: string; bot: Bot };

export async function saveBrowserPair(server: Server, secret: string, add: (server: Server) => Promise<unknown>): Promise<void> {
  await setItem(`winglet.sign.${server.id}`, secret);
  await add(server);
}

/** Ephemeral browser identity. Neither the public view state nor the QR contains a credential. */
export class BrowserDeviceLink {
  state: BrowserLinkState = { phase: 'idle' };
  private keys?: { secret: string; public: string };
  private key?: ServerKeyInfo;
  private pending?: Created;
  private claimed?: Claimed;
  private serverId?: string;
  private active = true;
  private busy = false;
  private deadline = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  constructor(private base: string, private name: string,
    private save: (server: Server, secret: string) => Promise<void>,
    private changed: (state: BrowserLinkState) => void, private clock = Date.now) {}
  private emit(change: Partial<BrowserLinkState>) { this.state = { ...this.state, ...change }; if (this.active) this.changed(this.state); }
  private clear() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  pause() { this.active = false; this.clear(); this.abort?.abort(); }
  beginManual(): boolean {
    if (this.busy || this.claimed || this.state.phase === 'paired') return false;
    this.pause(); return true;
  }
  resume() {
    this.active = true;
    this.changed(this.state);
    if (this.state.phase === 'idle') void this.start();
    else if (this.state.phase === 'waiting') void this.poll();
  }
  private schedule() {
    this.clear();
    if (this.active && this.state.phase === 'waiting') this.timer = setTimeout(() => { void this.poll(); }, 1200);
  }
  async start() {
    if (this.busy || this.claimed || !this.active) return;
    this.clear(); this.busy = true; this.pending = undefined; this.keys = undefined;
    this.state = { phase: 'creating' }; this.changed(this.state);
    try {
      const base = safeBase(this.base);
      if (!base || new URL(this.base).hash) throw new Error('Use the address of the server hosting this browser.');
      this.base = base;
      const info = await fetchInfo(base);
      if (!this.active) { this.emit({ phase: 'idle' }); return; }
      if (info.features?.device_linking !== true) { this.emit({ phase: 'unsupported' }); return; }
      this.serverId = info.server_id;
      // This self-consistent key is used only to seal a request, not trusted for authentication.
      // The already-verified owner must match the QR fingerprint to its existing pin before approval.
      const key = await serverKey(base);
      if (!this.active) { this.emit({ phase: 'idle' }); return; }
      if (!key) throw new Error('Update Winglet on the server to use QR sign-in.');
      this.key = key; this.keys = newSigningKey(); this.abort = new AbortController();
      const created = await request<Created>(`${base}/api/device-links`, { method: 'POST', signal: this.abort.signal,
        body: JSON.stringify({ sealed: seal(key, 'device-link-create', '', { device_name: this.name, platform: 'web', sign_key: this.keys.public }) }) });
      if (!/^[A-Za-z0-9_-]{32}$/.test(created.id) || !/^[A-Za-z0-9_-]{16,256}$/.test(created.poll_token)
        || !/^\d{6}$/.test(created.verification_code) || !Number.isFinite(created.expires_at) || created.fingerprint !== key.fingerprint) throw new Error('The server returned an invalid sign-in request.');
      this.pending = created; this.deadline = Math.min(created.expires_at * 1000, this.clock() + 180000);
      this.emit({ phase: 'waiting', qr: `${base}/#link=${created.id}&fp=${key.fingerprint}`, code: created.verification_code, expiresAt: this.deadline });
      this.schedule();
    } catch (e) { this.emit({ phase: 'error', error: (e as Error).message }); }
    finally { this.busy = false; }
  }
  async poll() {
    if (!this.active || this.busy || this.state.phase !== 'waiting' || !this.pending || !this.keys || !this.key) return;
    this.clear();
    if (this.clock() >= this.deadline) { this.emit({ phase: 'expired' }); return; }
    this.busy = true; this.abort = new AbortController();
    try {
      const { id, poll_token } = this.pending;
      const signature = b64e(ed25519.sign(new TextEncoder().encode(`winglet-device-link-claim-v1\n${id}\n${poll_token}`), b64d(this.keys.secret)));
      const result = await request<Claimed | { status: 'pending' | 'denied'; expires_at: number }>(`${this.base}/api/device-links/${id}/claim`, {
        method: 'POST', signal: this.abort.signal, body: JSON.stringify({ sealed: seal(this.key, 'device-link-claim', id, { poll_token, signature }) }),
      });
      if (result.status === 'paired') {
        if (result.server_id !== this.serverId || !result.token || !result.device?.id || result.me?.verified !== true
          || !['owner', 'member'].includes(result.me.role)) throw new Error('The server did not return a verified browser identity.');
        this.claimed = result;
        if (this.active) await this.retrySave();
        else this.emit({ phase: 'save-error', error: 'Sign-in was approved. Save this browser to finish.' });
      } else if (this.active) {
        if (this.clock() >= this.deadline) this.emit({ phase: 'expired' });
        else if (result.status === 'denied') this.emit({ phase: 'denied' });
        else if (result.status === 'pending') this.emit({ error: undefined });
        else throw new Error('The server returned an unknown sign-in state.');
      }
    } catch (e) {
      if (this.active) {
        const status = (e as { status?: number }).status;
        if (status === 404 || this.clock() >= this.deadline) this.emit({ phase: 'expired' });
        else if (status === 0 || (status !== undefined && status >= 500)) this.emit({ error: 'Connection interrupted. Retrying until this QR expires.' });
        else this.emit({ phase: 'error', error: (e as Error).message });
      }
    } finally { this.busy = false; this.schedule(); }
  }
  async retrySave() {
    if (!this.active || !this.claimed || !this.keys || !this.key || this.state.phase === 'saving' || this.state.phase === 'paired') return;
    this.emit({ phase: 'saving', error: undefined }); this.clear();
    const data = this.claimed;
    try {
      await this.save({ id: data.server_id, url: this.base, token: data.token, deviceId: data.device.id, bot: data.bot,
        fingerprint: this.key.fingerprint, wsAuth: true, addedAt: this.clock() }, this.keys.secret);
      this.emit({ phase: 'paired', role: data.me.role, qr: undefined, code: undefined });
      this.keys = undefined; this.pending = undefined; this.claimed = undefined;
    } catch { this.emit({ phase: 'save-error', error: 'Approved, but this browser could not save its sign-in. Retry saving; do not create another device.' }); }
  }
}

export type LinkPreview = DeviceLink & { server: Server; device_name: string; platform: 'web'; sign_key: string;
  verification_code: string; expires_at: number; status: 'pending' | 'approved' | 'denied' };
type OwnerRuntime = Record<string, { me?: Pick<Me, 'role' | 'verified'> } | undefined>;
function trustedOwner(link: DeviceLink, servers: Server[], runtime: OwnerRuntime): Server {
  // A QR cannot choose where we send a saved credential. Match an existing parent pairing exactly.
  const server = servers.find((s) => !s.parent && safeBase(s.url) === link.url && s.fingerprint === link.fp);
  const me = server && runtime[server.id]?.me;
  if (!server || me?.role !== 'owner' || me.verified !== true) throw new Error('Use a verified owner device already paired with this server. To connect this phone first, use a pairing link.');
  return { ...server, profile: undefined };
}
export async function previewDeviceLink(text: string, servers: Server[], runtime: OwnerRuntime, now = Date.now()): Promise<LinkPreview> {
  const link = parseDeviceLink(text);
  if (!link) throw new Error('That is not a Winglet browser sign-in QR.');
  const server = trustedOwner(link, servers, runtime);
  if (!await hasSigningKey(server)) throw new Error('Verify this device before approving a browser.');
  await serverKey(server.url, server.fingerprint);
  const data = await signedApi<Omit<LinkPreview, keyof DeviceLink | 'server'> & { id: string }>(server, 'GET', `/api/device-links/${link.id}`);
  if (data.id !== link.id || data.platform !== 'web' || !/^[A-Za-z0-9_-]{43}$/.test(data.sign_key) || !/^\d{6}$/.test(data.verification_code)
    || !Number.isFinite(data.expires_at) || !['pending', 'approved', 'denied'].includes(data.status)) throw new Error('The server returned an invalid browser request.');
  if (data.expires_at * 1000 <= now) throw new Error('This request expired. Choose New QR in the browser.');
  return { ...data, ...link, server };
}
export async function decideDeviceLink(preview: LinkPreview, action: 'approve' | 'deny', role: Role, confirmed: boolean,
  servers: Server[], runtime: OwnerRuntime, now = Date.now()): Promise<void> {
  if (preview.expires_at * 1000 <= now || preview.status !== 'pending') throw new Error('This request expired or was already handled. Choose New QR in the browser.');
  const server = trustedOwner(preview, servers, runtime);
  if (server.id !== preview.server.id || server.deviceId !== preview.server.deviceId) throw new Error('The approving device changed. Scan the request again.');
  if (action === 'approve' && (!confirmed || !['owner', 'member'].includes(role))) throw new Error('Confirm the check codes match the browser you are signing into.');
  await signedApi(server, 'POST', `/api/device-links/${preview.id}/${action}`, action === 'approve'
    ? { role, sign_key: preview.sign_key, verification_code: preview.verification_code } : {});
}

export type DeviceLink = { url: string; id: string; fp: string };
function safeBase(text: string): string | null {
  try {
    const u = new URL(text);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search) return null;
    return normalizeUrl(`${u.origin}${u.pathname}`);
  } catch { return null; }
}
/** No navigation or requests. Only a public request id and pinned fingerprint belong in this QR. */
export function parseDeviceLink(text: string): DeviceLink | null {
  try {
    const u = new URL(text.trim()), base = safeBase(text.trim());
    const match = u.hash.match(/^#link=([A-Za-z0-9_-]{32})&fp=([A-Za-z0-9_-]{22})$/);
    return base && match ? { url: base, id: match[1], fp: match[2] } : null;
  } catch { return null; }
}
