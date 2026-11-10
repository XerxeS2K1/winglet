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

export function shadeToggleView(state: ShadeApprovals | null, me: ShadeRole) {
  if (!state) return { value: false, disabled: true, note: 'Checking this phone’s notification setting…' };
  if (state.can_enable) return {
    value: state.shade_approvals,
    disabled: false,
    note: state.shade_approvals
      ? 'Approve and Decline can appear on notifications. Approve needs the command visible, so it is hidden while previews are off or the phone is locked.'
      : 'Off. Approvals still open the full card.',
  };
  if (me?.role && me.role !== 'owner') return {
    value: state.shade_approvals, disabled: true,
    note: 'Only an owner can turn on approval actions.',
  };
  if (me && !me.verified) return {
    value: state.shade_approvals, disabled: true,
    note: 'Verify this phone before turning on approval actions.',
  };
  return {
    value: state.shade_approvals, disabled: true,
    note: 'Only a verified owner can turn on approval actions.',
  };
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
