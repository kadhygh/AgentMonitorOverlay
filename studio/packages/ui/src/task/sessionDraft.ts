// What is being written in a session's composer, kept per session across switching sessions and restarts (2026-10-15:
// a restart emptied the box). One map in storage; an emptied box drops its entry, and only the most recent drafts stay.

const KEY = "amo.sessionDrafts";
const MAX = 50;

type Drafts = Record<string, { text: string; at: number }>;

function readAll(): Drafts {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Drafts) : {};
  } catch {
    return {};
  }
}

/** The session's kept draft, "" when none. */
export function readSessionDraft(sessionId: string | null | undefined): string {
  if (!sessionId) return "";
  const d = readAll()[sessionId];
  return d && typeof d.text === "string" ? d.text : "";
}

/** Keeps the session's draft; an empty one is forgotten. */
export function writeSessionDraft(sessionId: string | null | undefined, text: string, now = Date.now()): void {
  if (!sessionId) return;
  try {
    const all = readAll();
    if (text.trim()) all[sessionId] = { text, at: now };
    else if (sessionId in all) delete all[sessionId];
    else return;
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // per-viewer convenience only
  }
}
