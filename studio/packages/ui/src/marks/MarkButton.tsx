import { useState } from "react";
import { baseName } from "../attach/refs.js";
import { HostApiError, type HostLink } from "../host/client.js";
import type { FileRef } from "../lib/openin.js";
import { findMark } from "./logic.js";
import { addFileMark, bookmarkAdded, markTarget, openMarks } from "./open.js";
import { BookmarkCancelled } from "./NotePrompt.js";
import { useFileMarks } from "./useFileMarks.js";

/**
 * "书签" (标记 before 2026-10-19) for a file shown elsewhere (the conversation's quick look, the viewer, the Review
 * window). It says whether the file is bookmarked. Bookmarked: "已加书签" in the accent colour, and a click opens the
 * bookmarks window at it. Not yet: a click bookmarks it (at `line` when given; under the topic of `sessionId`'s task)
 * and opens the window with the cursor in the new bookmark's note.
 */
export function MarkButton({ link, file, line, sessionId, className = "btn-ghost small" }: { link: HostLink; file: FileRef; line?: number | null; sessionId?: string | null; className?: string }) {
  const { marks } = useFileMarks(link);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mark = marks ? findMark(marks, file, line) : null;

  const onClick = async () => {
    setError(null);
    if (mark) {
      openMarks(markTarget(mark));
      return;
    }
    setBusy(true);
    try {
      const r = await addFileMark(link, file, line, sessionId);
      if (r.created) bookmarkAdded(baseName(file.path));
      else openMarks(markTarget(r.mark));
    } catch (err) {
      if (!(err instanceof BookmarkCancelled)) setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const where = mark?.startLine ? `（第 ${mark.startLine}${mark.endLine && mark.endLine !== mark.startLine ? `–${mark.endLine}` : ""} 行）` : "";
  return (
    <button
      type="button"
      className={className}
      data-marked={mark ? "" : undefined}
      disabled={busy}
      onClick={() => void onClick()}
      title={
        error ??
        (mark
          ? `已加书签${where}${mark.note ? `：${mark.note.split("\n")[0]}` : ""}\n点击打开书签窗口查看`
          : `把这个文件${line ? `（第 ${line} 行）` : ""}加到书签（先写说明）；之后可以 @ 或拖进对话`)
      }
      data-testid="mark-file"
    >
      {error ? "加书签失败" : mark ? "已加书签" : "书签"}
    </button>
  );
}
