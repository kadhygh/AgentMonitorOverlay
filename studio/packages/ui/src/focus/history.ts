// Focus 历史 (2026-10-20): the last things that needed the person (an approval, a question, a reply that ended, a
// failure, a decision), each with when it came and whether it has been dealt with since; a click goes to it in the
// workbench. Kept in localStorage (per machine, like the windows); only the newest are kept.

export interface FocusRecord {
  /** What it is about: `s:<session id>` or `d:<decision id>`. One record per stretch of waiting, whatever the status. */
  key: string;
  sessionId: string;
  taskId: string | null;
  /** What it was, as Focus said it then ("完成待审核", "等待审批", "出错", "决策"…). */
  label: string;
  at: string;
  /** When it left the list (dealt with, seen, or moved on); null while it still waits. */
  handledAt: string | null;
}

export interface Attention {
  key: string;
  sessionId: string;
  taskId: string | null;
  label: string;
}

export const HISTORY_MAX = 10;
const KEY = "amo.focusHistory";

/**
 * New attention is added on top; a waiting record follows what it now is (a session that went from 等待审批 to 完成待审核
 * stays one record); what is no longer there is marked handled; the newest HISTORY_MAX are kept.
 */
export function updateHistory(
  before: readonly FocusRecord[],
  now: readonly Attention[],
  at = new Date().toISOString(),
  /** Whether a record's session is working again (then a moment's waiting was no more than its start). */
  working: (r: FocusRecord) => boolean = () => false,
): FocusRecord[] {
  const current = new Map(now.map((a) => [a.key, a]));
  const known = new Set(before.filter((r) => r.handledAt === null).map((r) => r.key));
  const added = now.filter((a) => !known.has(a.key)).map((a): FocusRecord => ({ ...a, at, handledAt: null }));
  const kept = before.flatMap((r) => {
    if (r.handledAt !== null) return [r];
    const still = current.get(r.key);
    if (still) return [{ ...r, label: still.label }];
    // Working again within moments (a new session is idle for an instant before it starts): nothing the person missed.
    return Date.parse(at) - Date.parse(r.at) < BLIP_MS && working(r) ? [] : [{ ...r, handledAt: at }];
  });
  return [...added, ...kept].slice(0, HISTORY_MAX);
}

/** What needed the person for less than this leaves no record. */
export const BLIP_MS = 5000;

export function readHistory(): FocusRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as FocusRecord[]).filter((r) => r && typeof r.key === "string" && typeof r.sessionId === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

export function writeHistory(list: readonly FocusRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // no storage: the history lasts as long as the window
  }
}
