import { useEffect, useRef } from "react";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { baseName } from "../attach/refs.js";
import type { FileRef } from "../lib/openin.js";
import { findMark, marksHash, type MarksTarget } from "./logic.js";

// Opening the marks window (文件标记, S12-D), its Ctrl+Shift+M key in the workbench, and marking a file from elsewhere.

type MarksBridge = { openMarks?(target: MarksTarget): Promise<void> };

/** Opens (or brings forward) the one marks window, showing `workspaceId` first; outside Electron, a new tab. */
export function openMarks(target: MarksTarget = {}): void {
  const bridge = window.amo as MarksBridge | undefined;
  if (bridge?.openMarks) void bridge.openMarks(target);
  else window.open(`${location.pathname}${location.search}${marksHash(target)}`, "_blank");
}

/** Ctrl+Shift+M in this window (not a global key): the marks window, at the project `current()` names. */
export function useMarksShortcut(current: () => string | null | undefined): void {
  const ref = useRef(current);
  ref.current = current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "m") return;
      e.preventDefault();
      const ws = ref.current();
      openMarks(ws ? { workspaceId: ws } : {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Marks a file (from the file selector and the like); says whether it was new, or why it failed. */
export async function markFile(link: HostLink, path: string): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  try {
    const r = await call(link, "POST /api/file-marks", {}, { path });
    return { ok: true, created: r.created };
  } catch (err) {
    return { ok: false, error: err instanceof HostApiError ? err.message : String(err) };
  }
}

/**
 * 标记 from a menu (stage 13, as the 标记 button): a file already marked opens the marks window at its mark; otherwise
 * it is marked (at `line` when given) and the window opens with the cursor in the new mark's note.
 */
export async function markOrShow(link: HostLink, file: FileRef, line?: number | null): Promise<void> {
  const known = findMark(await call(link, "GET /api/file-marks"), file, line);
  if (known) {
    openMarks({ ...(known.workspaceId ? { workspaceId: known.workspaceId } : {}), markId: known.id });
    return;
  }
  const r = await call(link, "POST /api/file-marks", {}, { path: file.path, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}), ...(line ? { startLine: line } : {}) });
  openMarks({ ...(r.mark.workspaceId ? { workspaceId: r.mark.workspaceId } : {}), markId: r.mark.id, edit: r.created });
}

/** markFile, said in a line ("已标记 a.ts", "a.ts 已经标记过", or the error). */
export async function markFileMessage(link: HostLink, path: string): Promise<string> {
  const r = await markFile(link, path);
  const name = baseName(path);
  return r.ok ? (r.created ? `已标记 ${name}` : `${name} 已经标记过`) : `标记失败：${r.error}`;
}
