/**
 * The one-time "keep Winglet running in the background?" question.
 *
 * Android never lets an app switch its own battery limit off. It can only ask, and the person answers in
 * Android's own dialog. So Winglet explains why in one sentence, asks once, and never asks again, whatever the
 * answer. It is marked as asked BEFORE the question is shown, so being killed mid-dialog cannot make it repeat.
 */
export const BATTERY_PROMPT_KEY = 'winglet.batteryPromptAsked.v1';

export type BatteryNative = {
  batteryUnrestricted?: () => boolean;
  requestBatteryUnrestricted?: () => void;
};

export type BatteryDeps = {
  android: boolean;
  native: BatteryNative | null | undefined;
  wasAsked: () => Promise<boolean>;
  markAsked: () => Promise<void>;
  /** Shows our own explanation; true when the person chose to continue. */
  confirm: () => Promise<boolean>;
};

export type BatteryOutcome = 'unsupported' | 'already-asked' | 'already-allowed' | 'declined' | 'requested' | 'failed';

export async function askAboutBatteryOnce(d: BatteryDeps): Promise<BatteryOutcome> {
  const n = d.native;
  if (!d.android || !n?.batteryUnrestricted || !n.requestBatteryUnrestricted) return 'unsupported';
  try {
    if (await d.wasAsked()) return 'already-asked';
    if (n.batteryUnrestricted()) { await d.markAsked(); return 'already-allowed'; }
    await d.markAsked();
    if (!(await d.confirm())) return 'declined';
    n.requestBatteryUnrestricted();
    return 'requested';
  } catch {
    return 'failed'; // never let a settings question get in the way of opening the app
  }
}

export const BATTERY_PROMPT_COPY = {
  title: 'Keep Winglet connected?',
  message: 'Android can put Winglet to sleep when the phone is idle, which delays messages and can make it look offline '
    + 'when you open it. On the next screen, choose Allow to stop that. This is asked once and never again.',
  later: 'Not now',
  go: 'Continue',
};
