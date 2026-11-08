import { api, fetchInfo, normalizeUrl, pair, parsePairLink, verifyDevice } from './api';
import type { Device, Role, Server } from './types';

type PairingStore = {
  servers: Server[];
  addServer: (server: Server) => Promise<unknown>;
  updateServer: (id: string, change: Partial<Server>, reconnect?: boolean) => Promise<unknown>;
};
export type PairingResult = { server: Server; existing: boolean; verified: boolean; role?: Role };

/** Scan and paste use exactly the same flow. Credentials never go to a scanned URL for an existing pairing. */
export async function connectPairing(input: string, code: string, name: string, store: PairingStore): Promise<PairingResult> {
  const link = parsePairLink(input);
  if (input.includes('#') && !link) throw new Error('Paste the whole, unchanged Winglet pairing link.');
  const url = link?.url ?? normalizeUrl(input), pairingCode = link?.code ?? code;
  if (!url || !pairingCode) throw new Error('Enter a pairing link, or your server address and pairing code.');
  const info = await fetchInfo(url);
  const existing = store.servers.find((s) => !s.parent && (s.id === info.server_id || normalizeUrl(s.url) === url));
  let server: Server;
  if (existing) {
    if (existing.id !== info.server_id) throw new Error('That address now reports a different server. Check the address before pairing.');
    if (link?.fp && existing.fingerprint && link.fp !== existing.fingerprint) throw new Error('This link has a different server key. Do not continue on this network.');
    server = link?.fp ? await verifyDevice(existing, pairingCode, link.fp) : existing;
    if (link?.fp) await store.updateServer(existing.id, { fingerprint: server.fingerprint }, true);
  } else {
    server = await pair(url, pairingCode, name, link?.fp);
    await store.addServer(server);
  }
  const who = await api<{ device: Device }>(server, '/api/me').catch(() => null);
  return { server, existing: !!existing, verified: !!server.fingerprint && who?.device?.verified === true, role: who?.device?.role };
}
