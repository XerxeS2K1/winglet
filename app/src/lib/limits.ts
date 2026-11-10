/**
 * Limits that the server enforces.
 *
 * `MAX_MESSAGE` mirrors `MAX_TEXT` in `plugin/hub.py`. The server refuses a longer message outright
 * (it used to slice it, which silently lost the tail), so the composer stops the user at the same
 * number instead of letting them send something that comes back as an error.
 */
export const MAX_MESSAGE = 16_000;
