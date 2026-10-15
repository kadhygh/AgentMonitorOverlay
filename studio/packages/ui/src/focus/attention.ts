// When the Focus robot dances (S14-J): something needs the person that they have not acknowledged yet. Each thing gets
// a key; clicking the robot or the list acknowledges every key on screen; a key that goes away (handled) is forgotten,
// so the same session asking again later makes the robot come back.

/** Keys of what needs the person now: sessions (with what they wait for), open decisions, scheduler proposals. */
export function attentionKeys(sessions: ReadonlyArray<{ id: string; status: string }>, decisionIds: readonly string[], proposalIds: readonly string[]): string[] {
  return [...sessions.map((s) => `s:${s.id}:${s.status}`), ...decisionIds.map((id) => `d:${id}`), ...proposalIds.map((id) => `p:${id}`)];
}

/** The acknowledged keys still on screen. */
export function pruneSeen(seen: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const now = new Set(keys);
  return new Set([...seen].filter((k) => now.has(k)));
}

/** Whether something on screen is new to the person. */
export function shouldAlert(keys: readonly string[], seen: ReadonlySet<string>): boolean {
  return keys.some((k) => !seen.has(k));
}

const LOCK_KEY = "amo.focusLocked";

/** 锁定位置: the Focus window cannot be dragged. Per machine, like where it was left. */
export function readFocusLocked(): boolean {
  try {
    return localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeFocusLocked(on: boolean): void {
  try {
    localStorage.setItem(LOCK_KEY, on ? "1" : "0");
  } catch {
    // a per-machine convenience only
  }
}
