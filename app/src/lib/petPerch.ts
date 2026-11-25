/** How far the message box's top edge stands above the bottom of the screen: the box itself plus the padding
 * under it. The pet sits on this, not on the whole composer stack, because the stack also holds the task card,
 * the steer/queue chips, the command list and the offline note. Those come and go while a turn runs, and a pet
 * pinned to the stack jumped each time one did. The box only changes when the user types, replies or attaches. */
export function boxStackHeight(boxHeight: number, bottomInset: number): number {
  return Math.round(boxHeight) + Math.max(bottomInset, 10);
}
