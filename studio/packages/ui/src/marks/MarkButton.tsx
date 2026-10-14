import { useState } from "react";
import { call, HostApiError, type HostLink } from "../host/client.js";
import type { FileRef } from "../lib/openin.js";
import { findMark } from "./logic.js";
import { openMarks } from "./open.js";
import { useFileMarks } from "./useFileMarks.js";

/**
 * "标记" for a file shown elsewhere (the conversation's quick look, the Review window). Stage 13: it says whether the
 * file is marked. Marked: "已标记" in the accent colour, and a click opens the marks window at that mark. Not marked: a
 * click marks it (at `line` when given) and opens the marks window with the cursor in the new mark's note.
 */
export function MarkButton({ link, file, line, className = "btn-ghost small" }: { link: HostLink; file: FileRef; line?: number | null; className?: string }) {
  const { marks } = useFileMarks(link);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mark = marks ? findMark(marks, file, line) : null;

  const onClick = async () => {
    setError(null);
    if (mark) {
      openMarks({ ...(mark.workspaceId ? { workspaceId: mark.workspaceId } : {}), markId: mark.id });
      return;
    }
    setBusy(true);
    try {
      const r = await call(link, "POST /api/file-marks", {}, { path: file.path, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}), ...(line ? { startLine: line } : {}) });
      openMarks({ ...(r.mark.workspaceId ? { workspaceId: r.mark.workspaceId } : {}), markId: r.mark.id, edit: r.created });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
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
          ? `已标记${where}${mark.note ? `：${mark.note.split("\n")[0]}` : ""}\n点击打开标记窗口查看`
          : `标记这个文件${line ? `（第 ${line} 行）` : ""}，然后写说明；之后可以 @ 或拖进对话`)
      }
      data-testid="mark-file"
    >
      {error ? "标记失败" : mark ? "已标记" : "标记"}
    </button>
  );
}
