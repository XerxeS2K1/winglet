/** How far the message box's top edge stands above the bottom of the screen: the box itself plus the padding
 * under it. The pet sits on this, not on the whole composer stack, because the stack also holds the task card,
 * the steer/queue chips, the command list and the offline note. Those come and go while a turn runs, and a pet
 * pinned to the stack jumped each time one did. The box only changes when the user types, replies or attaches. */
export function boxStackHeight(boxHeight: number, bottomInset: number): number {
  return Math.round(boxHeight) + Math.max(bottomInset, 10);
}

/** How far in from the left the rows that sit directly above the box start while a pet is perched: the pet
 * stands 42 px above the box at the left, so a row there ("While it works", the offline note) would be under it. */
export const PERCH_CLEAR = 52;

export function petClearance(petPerched: boolean): number {
  return petPerched ? PERCH_CLEAR : 0;
}
