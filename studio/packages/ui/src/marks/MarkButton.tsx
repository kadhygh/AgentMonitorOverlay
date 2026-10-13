import { useEffect, useState } from "react";
import { call, HostApiError, type HostLink } from "../host/client.js";
import type { FileRef } from "../lib/openin.js";

/**
 * "标记" for a file shown elsewhere (the conversation's quick look, the Review window): marks it, at `line` when given,
 * and says so in place for a moment ("已标记" / "已标记过"); the error goes to the title.
 */
export function MarkButton({ link, file, line, className = "btn-ghost small" }: { link: HostLink; file: FileRef; line?: number | null; className?: string }) {
  const [said, setSaid] = useState<{ text: string; error?: string } | null>(null);
  useEffect(() => {
    if (!said || said.error) return;
    const t = setTimeout(() => setSaid(null), 2500);
    return () => clearTimeout(t);
  }, [said]);
  useEffect(() => setSaid(null), [file.path, line]);
  const mark = async () => {
    try {
      const r = await call(link, "POST /api/file-marks", {}, { path: file.path, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}), ...(line ? { startLine: line } : {}) });
      setSaid({ text: r.created ? "已标记" : "已标记过" });
    } catch (err) {
      setSaid({ text: "标记失败", error: err instanceof HostApiError ? err.message : String(err) });
    }
  };
  return (
    <button
      type="button"
      className={className}
      onClick={() => void mark()}
      title={said?.error ?? `标记这个文件${line ? `（第 ${line} 行）` : ""}，写上说明后可以 @ 或拖进对话（Ctrl+Shift+M 打开标记窗口）`}
      data-testid="mark-file"
    >
      {said?.text ?? "标记"}
    </button>
  );
}
