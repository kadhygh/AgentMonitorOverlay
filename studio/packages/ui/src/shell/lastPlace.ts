import type { Scope } from "../board/Board.js";
import type { View } from "./views.js";

// Where the workbench was left (2026-10-15): the page (board, canvas, new task, or a task) and the left column's scope,
// and per task the session last looked at. A restart or reload comes back there. Kept in this window profile's storage.

const PLACE_KEY = "amo.lastPlace";
const SESSIONS_KEY = "amo.lastSessions";
const MAX_SESSIONS = 100;

type Back = { kind: "board" } | { kind: "canvas" };
type SavedView = { kind: "board" } | { kind: "canvas" } | { kind: "new" } | { kind: "task"; taskId: string; back?: Back };

const isBack = (v: unknown): v is Back => !!v && typeof v === "object" && ((v as Back).kind === "board" || (v as Back).kind === "canvas");

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-window convenience only
  }
}

function scopeOf(v: unknown): Scope {
  const s = v as { kind?: unknown; id?: unknown } | null;
  if (s && (s.kind === "topic" || s.kind === "workspace") && typeof s.id === "string") return { kind: s.kind, id: s.id };
  return { kind: "all" };
}

function lastSessions(): Record<string, string> {
  const v = readJson(SESSIONS_KEY);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
}

/** The place to open at: the page last left (a task with the session last looked at in it) and the scope. */
export function readPlace(): { view: View; scope: Scope } {
  const p = readJson(PLACE_KEY) as { view?: SavedView; scope?: unknown } | null;
  const scope = scopeOf(p?.scope);
  const v = p?.view;
  if (v?.kind === "task" && typeof v.taskId === "string") {
    const sessionId = lastSessions()[v.taskId];
    return { view: { kind: "task", taskId: v.taskId, ...(typeof sessionId === "string" ? { sessionId } : {}), ...(isBack(v.back) ? { back: v.back } : {}) }, scope };
  }
  if (v?.kind === "canvas" || v?.kind === "new") return { view: { kind: v.kind }, scope };
  return { view: { kind: "board" }, scope };
}

/** Keeps the page and scope in front (other pages, like a project's packs, come back as the board). */
export function savePlace(view: View, scope: Scope): void {
  const saved: SavedView =
    view.kind === "task"
      ? { kind: "task", taskId: view.taskId, ...(isBack(view.back) ? { back: { kind: view.back.kind } } : {}) }
      : view.kind === "canvas" || view.kind === "new"
        ? { kind: view.kind }
        : { kind: "board" };
  writeJson(PLACE_KEY, { view: saved, scope });
}

/** The session looked at in a task; the most recent tasks only. */
export function rememberSession(taskId: string, sessionId: string): void {
  const all = lastSessions();
  if (all[taskId] === sessionId) return;
  delete all[taskId];
  const kept = Object.entries(all).slice(-(MAX_SESSIONS - 1));
  writeJson(SESSIONS_KEY, Object.fromEntries([...kept, [taskId, sessionId]]));
}
