/** Which step of a hands-free turn failed, in the words the screen shows.
 *
 *  The raw message names the cause ("Can't reach your Hermes server…") but not the step, so a failed
 *  upload, a failed transcription and a failed playback all looked the same. Capture and session-loss
 *  messages already say what they are and are left alone. */
export type VoiceStep = 'openSession' | 'listen' | 'transcribe' | 'send' | 'speak';

const LEAD: Partial<Record<VoiceStep, string>> = {
  openSession: "Couldn't start the voice session.",
  transcribe: "Couldn't turn your speech into text.",
  speak: "Couldn't play the reply.",
};

export function stepError(step: VoiceStep, message: string): string {
  const lead = LEAD[step];
  const text = (message || '').trim();
  if (!lead) return text;
  if (!text) return lead;
  if (text.startsWith(lead)) return text;
  return `${lead} ${text}`;
}
