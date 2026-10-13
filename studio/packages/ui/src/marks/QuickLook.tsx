import { useEffect, useMemo, useRef, useState } from "react";
import { lineLabel, type FileMark, type TextFile } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { readTextFile } from "../lib/openin.js";
import { highlightLines, languageForPath, useGrammarLoads } from "../lib/highlight.js";
import { CodeTokens } from "../lib/CodeTokens.js";
import { formatBytes } from "../attach/refs.js";

/**
 * 快速查看 of a marked file: read-only text with line numbers, the marked lines tinted and scrolled to. A simple stand-in
 * until the conversation's richer file preview (S12-C) can be used here too. Esc or a click outside closes it.
 */
export function QuickLook({ link, mark, vscode, onOpenInEditor, onClose }: { link: HostLink; mark: FileMark; vscode: boolean; onOpenInEditor(): void; onClose(): void }) {
  const [file, setFile] = useState<TextFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useGrammarLoads();

  useEffect(() => {
    let live = true;
    readTextFile(link, { path: mark.path })
      .then((f) => live && setFile(f))
      .catch((err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [link, mark.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const lines = useMemo(() => (file?.text ?? "").replace(/\r\n?/g, "\n").split("\n"), [file]);
  const tokens = file?.text !== undefined ? highlightLines(file.text, languageForPath(mark.path)) : null;
  const start = mark.startLine ?? 0;
  const end = mark.endLine ?? mark.startLine ?? 0;

  // The marked lines come into view once the text is there.
  useEffect(() => {
    if (!file?.text || !start) return;
    body.current?.querySelector(`[data-line="${start}"]`)?.scrollIntoView({ block: "center" });
  }, [file, start]);

  return (
    <div className="mk-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mk-look" role="dialog" aria-label="快速查看" data-testid="mark-quicklook">
        <div className="mk-look-head">
          <span className="mk-look-path" title={mark.path}>
            {mark.path}
          </span>
          {start > 0 && <span className="mk-dim">{lineLabel(mark.startLine, mark.endLine)}</span>}
          {file && <span className="mk-dim">{formatBytes(file.size)}</span>}
          <span className="spacer" />
          {vscode && (
            <button type="button" className="btn-ghost small" onClick={onOpenInEditor}>
              VS Code 打开
            </button>
          )}
          <button type="button" className="btn-ghost small" onClick={onClose} aria-label="关闭快速查看">
            关闭
          </button>
        </div>
        <div className="mk-look-body" ref={body}>
          {error && <div className="mk-look-note error">{error}</div>}
          {!file && !error && <div className="mk-look-note">正在读取…</div>}
          {file?.binary && <div className="mk-look-note">这是二进制文件，不能预览。</div>}
          {file?.tooLarge && <div className="mk-look-note">文件太大（{formatBytes(file.size)}），请用编辑器打开。</div>}
          {file?.text !== undefined && (
            <div className="mk-look-lines">
              {lines.map((line, i) => {
                const n = i + 1;
                const hit = start > 0 && n >= start && n <= end;
                return (
                  <div key={n} className={hit ? "mk-look-line hit" : "mk-look-line"} data-line={n}>
                    <span className="mk-look-no">{n}</span>
                    <span className="mk-look-text">
                      <CodeTokens tokens={tokens?.[i]} text={line} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
