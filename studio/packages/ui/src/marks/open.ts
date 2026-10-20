import { useEffect, useRef } from "react";
import type { ChatMark } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import type { SelectionAnchor } from "../lib/selection.js";
import { baseName } from "../attach/refs.js";
import type { FileRef } from "../lib/openin.js";
import { findMark, marksHash, type MarksTarget } from "./logic.js";
import { passageTrace } from "../lib/passageTrace.js";

// Opening the marks window (文件标记, S12-D; 书签 since 2026-10-19), its Ctrl+Shift+M key in the workbench, and
// bookmarking a file or a passage from elsewhere.

type MarksBridge = { openMarks?(target: MarksTarget): Promise<void> };

/** Opens (or brings forward) the one bookmarks window, showing `topicId` first; outside Electron, a new tab. */
export function openMarks(target: MarksTarget = {}): void {
  const bridge = window.amo as MarksBridge | undefined;
  if (bridge?.openMarks) void bridge.openMarks(target);
  else window.open(`${location.pathname}${location.search}${marksHash(target)}`, "_blank");
}

/** Ctrl+Shift+M in this window (not a global key): the bookmarks window, at the topic `current()` names. */
export function useMarksShortcut(current: () => MarksTarget): void {
  const ref = useRef(current);
  ref.current = current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "m") return;
      e.preventDefault();
      openMarks(ref.current());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Marks a file (from the file selector and the like); says whether it was new, or why it failed. */
export async function markFile(link: HostLink, path: string, sessionId?: string): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  try {
    const r = await call(link, "POST /api/file-marks", {}, { path, ...(sessionId ? { sessionId } : {}) });
    return { ok: true, created: r.created };
  } catch (err) {
    return { ok: false, error: err instanceof HostApiError ? err.message : String(err) };
  }
}

/** Where the bookmarks window shows a bookmark: its topic first. */
export const markTarget = (m: { id: string; topicId: string | null }, edit = false): MarksTarget => ({ topicId: m.topicId ?? "none", markId: m.id, ...(edit ? { edit } : {}) });

/**
 * 书签 from a menu (stage 13, as the 书签 button): a file already bookmarked opens the window at it; otherwise it is
 * bookmarked (at `line` when given; under the topic of `sessionId`'s task) and the window opens with the cursor in
 * the new one's note.
 */
export async function markOrShow(link: HostLink, file: FileRef, line?: number | null, sessionId?: string): Promise<void> {
  const known = findMark(await call(link, "GET /api/file-marks"), file, line);
  if (known) {
    openMarks(markTarget(known));
    return;
  }
  const r = await call(link, "POST /api/file-marks", {}, { path: file.path, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}), ...(line ? { startLine: line } : {}), ...(sessionId ? { sessionId } : {}) });
  openMarks(markTarget(r.mark, r.created));
}

/** Bookmarks a selected passage of a reply under the session's topic (2026-10-19). */
export async function bookmarkPassage(link: HostLink, sessionId: string, anchor: SelectionAnchor): Promise<{ mark: ChatMark; created: boolean }> {
  return call(link, "POST /api/chat-marks", {}, { sessionId, itemId: anchor.itemId, start: anchor.start, end: anchor.end, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix });
}

/** Opens the conversation a passage is in, in the workbench, scrolled to the passage and flashing it. */
export function openPassage(m: ChatMark): void {
  passageTrace("打开对话", { mark: m.id, taskId: m.taskId ?? null, sessionId: m.sessionId, itemId: m.itemId, start: m.start, end: m.end, exists: m.exists, bridge: !!window.amo?.openInWorkbench });
  if (!m.taskId) return;
  void window.amo?.openInWorkbench?.({ taskId: m.taskId, sessionId: m.sessionId, passage: { itemId: m.itemId, start: m.start, end: m.end, quote: m.quote } });
}

/** markFile, said in a line ("已标记 a.ts", "a.ts 已经标记过", or the error). */
export async function markFileMessage(link: HostLink, path: string, sessionId?: string): Promise<string> {
  const r = await markFile(link, path, sessionId);
  const name = baseName(path);
  return r.ok ? (r.created ? `已加书签 ${name}` : `${name} 已经在书签里`) : `加书签失败：${r.error}`;
}
