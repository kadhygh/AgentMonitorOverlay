// Focus sends the person to a session to deal with it (2026-10-21): an approval, a question, a reply to review. Opening
// it in Focus first already counts as seeing it, so the workbench could not tell any more that the person came to
// deal with it; Focus notes the jump here (localStorage, shared with the workbench) just before asking for it.

const KEY = "amo.focusJump";
/** A note older than this is not about the session opening now. */
const FRESH_MS = 15_000;

export function noteFocusJump(sessionId: string, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sessionId, at: now }));
  } catch {
    // no storage: no hint
  }
}

/** Whether Focus just sent the person to this session. */
export function cameFromFocus(sessionId: string, now = Date.now()): boolean {
  try {
    const jump = JSON.parse(localStorage.getItem(KEY) ?? "null") as { sessionId?: unknown; at?: unknown } | null;
    return !!jump && jump.sessionId === sessionId && typeof jump.at === "number" && now - jump.at >= 0 && now - jump.at < FRESH_MS;
  } catch {
    return false;
  }
}

/** The workbench opened that session: the note has done its work (going back to it later is not coming from Focus). */
export function forgetFocusJump(sessionId: string): void {
  try {
    if (cameFromFocus(sessionId)) localStorage.removeItem(KEY);
  } catch {
    // no storage
  }
}
