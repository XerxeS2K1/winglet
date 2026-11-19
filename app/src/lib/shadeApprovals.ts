import { api, signedApi } from './api';
import type { Server } from './types';

/** The server's per-device switch for answering approvals from a notification. */
export type ShadeApprovals = {
  shade_approvals: boolean;
  epoch: number;
  /** Owner and verified: the server will accept a change from this phone. */
  can_enable: boolean;
};

export type ShadeRole = { role?: string; verified?: boolean } | undefined;

/** What the screen knows about one server: its saved setting (null until read), who this phone is
 * there, and whether reading it failed. */
export type ServerShade = { state: ShadeApprovals | null; me: ShadeRole; failed?: boolean };

export type ActionsSwitchView = {
  value: boolean;
  disabled: boolean;
  note: string;
  /** Show the small button that turns approvals on at the server. */
  enableApprovals: boolean;
};

/**
 * The one "Reply and approve from notifications for this phone" row. `master` is the phone's own
 * switch (null while it has not been read). The switch controls Reply and Decline for every phone;
 * Approve also needs a verified owner and the server's own flag.
 */
export function actionsSwitchView(master: boolean | null, servers: ServerShade[]): ActionsSwitchView {
  const loading = master === null || servers.some((s) => !s.state && !s.failed);
  if (loading) return { value: !!master, disabled: true, enableApprovals: false, note: 'Checking this phone’s notification setting…' };
  if (!master) return {
    value: false, disabled: false, enableApprovals: false,
    note: 'Off. Notifications show no buttons and just open Winglet.',
  };
  const owners = servers.filter((s) => s.state?.can_enable);
  if (owners.length) {
    const serverOff = owners.some((s) => !s.state?.shade_approvals);
    return {
      value: true, disabled: false, enableApprovals: serverOff,
      note: serverOff
        ? 'Reply and Decline can appear on notifications. Approve is off on your server.'
        : 'Approve, Decline and Reply can appear on notifications. Approve needs the command visible, so it is hidden while previews are off or the phone is locked.',
    };
  }
  const unverifiedOwner = servers.some((s) => s.me?.role === 'owner' && !s.me.verified);
  return {
    value: true, disabled: false, enableApprovals: false,
    note: unverifiedOwner
      ? 'Reply and Decline can appear on notifications. Verify this phone to approve from them.'
      : 'Reply and Decline can appear on notifications. Approving needs a verified owner.',
  };
}

/** Approvals-only row for an older native shell that has no phone-wide switch: the owner still
 * controls server approvals, and the note says this build cannot switch Reply and Decline. */
export function approvalsOnlyView(servers: ServerShade[]): ActionsSwitchView {
  const limit = 'This build cannot switch replies and Decline.';
  if (servers.some((s) => !s.state && !s.failed)) return { value: false, disabled: true, enableApprovals: false, note: 'Checking this phone’s notification setting…' };
  const owners = servers.filter((s) => s.state?.can_enable);
  if (owners.length) {
    const value = owners.every((s) => s.state?.shade_approvals);
    return {
      value, disabled: false, enableApprovals: false,
      note: `${limit} ${value ? 'Approve can appear on notifications. It needs the command visible, so it is hidden while previews are off or the phone is locked.' : 'Off. Approvals still open the full card.'}`,
    };
  }
  const value = servers.some((s) => s.state?.shade_approvals);
  if (servers.some((s) => s.me?.role === 'owner' && !s.me.verified)) return { value, disabled: true, enableApprovals: false, note: `${limit} Verify this phone before turning on approval actions.` };
  if (servers.some((s) => s.me?.role && s.me.role !== 'owner')) return { value, disabled: true, enableApprovals: false, note: `${limit} Only an owner can turn on approval actions.` };
  return { value, disabled: true, enableApprovals: false, note: `${limit} Only a verified owner can turn on approval actions.` };
}

type Save = (server: Server, enabled: boolean) => Promise<ShadeApprovals>;
export type ServerState = { server: Server; state: ShadeApprovals | null };
export type SwitchResult = { ok: true; states: (ShadeApprovals | null)[] } | { ok: false; message: string; states: (ShadeApprovals | null)[] };

/** Save the server flag on every server this phone may change (owner and verified). A server
 * already in the wanted state is left alone, so no needless owner-signed write and no epoch bump.
 * If a server fails, the servers this save already changed are put back, newest first (best
 * effort), so the phone and the servers agree again. A rollback that fails too is named in the
 * error text, and that server keeps the value it really has. */
export async function saveShadeEverywhere(enabled: boolean, servers: ServerState[], save: Save): Promise<SwitchResult> {
  const states = servers.map((s) => s.state);
  const changed: number[] = [];
  for (let i = 0; i < servers.length; i++) {
    const state = servers[i].state;
    if (!state?.can_enable || state.shade_approvals === enabled) continue;
    try { states[i] = await save(servers[i].server, enabled); changed.push(i); }
    catch (e) {
      let message = (e as Error).message;
      const stuck: { name: string; why: string }[] = [];
      for (const j of changed.reverse()) {
        try { states[j] = await save(servers[j].server, servers[j].state!.shade_approvals); }
        catch (back) { stuck.push({ name: servers[j].server.bot?.title || servers[j].server.id, why: (back as Error).message }); }
      }
      if (stuck.length) message += ` Could not put ${stuck.map((x) => x.name).join(', ')} back (${stuck.map((x) => x.why).join('; ')}), so ${stuck.length > 1 ? 'those servers still have' : 'that server still has'} the new setting.`;
      return { ok: false, message, states };
    }
  }
  return { ok: true, states };
}

/** The small button: turn approvals on at every server this phone may change. The phone's own switch stays as it is. */
export function enableApprovals(servers: ServerState[], save: Save): Promise<SwitchResult> {
  return saveShadeEverywhere(true, servers, save);
}

/** Flip the phone's switch and carry it to every server this phone may change. A failed server
 * save rolls the servers back (see above) and puts the phone's switch back to `previous`. */
export async function setActionsSwitch(
  enabled: boolean, previous: boolean, servers: ServerState[],
  io: { setNative: (enabled: boolean) => void; save: Save },
): Promise<SwitchResult> {
  const states = servers.map((s) => s.state);
  try { io.setNative(enabled); } catch (e) { return { ok: false, message: (e as Error).message, states }; }
  const result = await saveShadeEverywhere(enabled, servers, io.save);
  if (result.ok) return result;
  try { io.setNative(previous); } catch { /* keep the server error: it is the one worth showing */ }
  return result;
}

/** What the screen hands the row's handler. `native` is the native module (undefined or without
 * setActions on an older build), `master` the phone's own switch (null until read). */
export type ChangeActionsContext = {
  view: { disabled: boolean };
  busy: boolean;
  master: boolean | null;
  rows: ServerState[];
  native: { setActions?: (enabled: boolean) => void } | null | undefined;
  save: Save;
  /** Called once the change is accepted, before any write: the screen sets busy and clears its notes. */
  begin: () => void;
};

/** The settings row's handler. Returns null when the change is ignored (row disabled, a save
 * already running, or the phone's value not read yet). The native flag gets exactly `enabled`;
 * `master` is only what a failed save puts back. Without setActions only the servers change. */
export async function changeActions(enabled: boolean, c: ChangeActionsContext): Promise<SwitchResult | null> {
  if (c.view.disabled || c.busy) return null;
  const setActions = c.native?.setActions;
  if (!setActions) { c.begin(); return saveShadeEverywhere(enabled, c.rows, c.save); }
  if (c.master === null) return null;
  c.begin();
  return setActionsSwitch(enabled, c.master, c.rows, { setNative: (v) => setActions.call(c.native, v), save: c.save });
}

export function loadShadeApprovals(server: Server): Promise<ShadeApprovals> {
  return api<ShadeApprovals>(server, '/api/push/shade');
}

export function saveShadeApprovals(server: Server, enabled: boolean): Promise<ShadeApprovals> {
  // The server's reviewed setting name is shade_approvals; it also returns the new epoch.
  return signedApi<ShadeApprovals>(server, 'PUT', '/api/push/shade', { shade_approvals: enabled });
}

/** What to tell the person after a save. The epoch stays in the data; it is not shown. */
export function shadeSavedNote(before: ShadeApprovals, after: ShadeApprovals): string {
  return after.epoch !== before.epoch ? 'Saved. Older notifications can no longer approve.' : 'Saved.';
}

export const SHADE_PREVIEW_NOTE =
  'Approve needs the command to be visible, so it will not appear while notification previews are off or the phone is locked. Decline and Reply follow the same rule.';
