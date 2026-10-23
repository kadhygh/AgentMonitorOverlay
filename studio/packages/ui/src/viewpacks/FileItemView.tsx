import { useEffect, useMemo, useRef, useState } from "react";
import type { FileViewItem, StateSnapshot, ViewPack, Workspace } from "@amo-studio/protocol";
import { copyText, HostApiError, type HostLink } from "../host/client.js";
import { openInEditor, revealInExplorer, type FileRef } from "../lib/openin.js";
import { showToast } from "../lib/toast.js";
import { FileContent, isImage, isMarkdownText, RenderedToggle, useTextFile } from "../files/FilePreview.js";
import { useVsCode } from "../files/FileLinks.js";
import { MarkButton } from "../marks/MarkButton.js";
import { FindBar } from "../gitreview/FindBar.js";
import type { ViewMark } from "../gitreview/DiffView.js";
import { FileReview } from "../viewer/FileReview.js";

// A 查看包's file (2026-10-23): the file as it is now, as the viewer shows one — code drawn with its lines taking
// comments (sent back to the pack's conversation by default), Markdown rendered — with the agent's 重点: tinted lines,
// each note under them, and a row of them on top to go from one to the next. 书签 as for any file.

export function FileItemView({ link, state, pack, workspace, item, nonce, active }: { link: HostLink; state: StateSnapshot; pack: ViewPack; workspace: Workspace; item: FileViewItem; nonce: string; active: boolean }) {
  const file: FileRef = { path: item.path, workspaceId: workspace.id };
  const [reload, setReload] = useState(0);
  const loaded = useTextFile(link, file, !isImage(item.path), `${reload}:${nonce}`);
  const markdown = isMarkdownText(item.path, loaded);
  const [rendered, setRendered] = useState(!item.highlights.length);
  // The 重点 opened at (the window opens at the first; a click on top opens another), and the one shown pressed on
  // top: the same, or the one Tab or a click on its lines went to since (2026-10-23: Tab works the bar on top).
  const [focus, setFocus] = useState(0);
  const [pressed, setPressed] = useState<number | null>(0);
  // Every click on top goes there, the same one again too (after Tab went elsewhere).
  const [clicks, setClicks] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const vscode = useVsCode(link);
  const marks = useMemo<ViewMark[]>(() => item.highlights.map((h) => ({ from: h.line, to: h.endLine ?? h.line, note: h.note })), [item.highlights]);
  const at = item.highlights[pressed ?? focus];
  const onActiveRow = (row: number | null) => {
    if (row === null) return;
    const i = item.highlights.findIndex((h) => row >= h.line - 1 && row <= (h.endLine ?? h.line) - 1);
    setPressed(i >= 0 ? i : null);
  };
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pressed]);
  // r 重新载入, as in the viewer's 文件 mode.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key.toLowerCase() !== "r" || e.ctrlKey || e.metaKey || e.altKey || el?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      setReload((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  const absolute = loaded.state === "ok" ? loaded.file.path : `${workspace.path}/${item.path}`;
  const code = loaded.state === "ok" && !isImage(item.path) && !loaded.file.binary && !loaded.file.tooLarge && loaded.file.text !== undefined && !(markdown && rendered);
  const fail = (err: unknown) => showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
  const renderedRef = useRef<HTMLDivElement>(null);

  return (
    <div className="vp-item" data-testid="viewpack-file">
      <div className="vp-item-head">
        <span className="vp-item-path" title={absolute}>
          {item.path}
        </span>
        <div className="vw-actions">
          {markdown && <RenderedToggle rendered={rendered} onChange={setRendered} />}
          {vscode && (
            <button type="button" className="btn-ghost small" onClick={() => openInEditor(link, file, at?.line).catch(fail)}>
              VS Code 打开
            </button>
          )}
          <button type="button" className="btn-ghost small" onClick={() => revealInExplorer(link, file).catch(fail)}>
            在资源管理器中显示
          </button>
          <button
            type="button"
            className="btn-ghost small"
            onClick={() =>
              void copyText(absolute).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
          >
            {copied ? "已复制" : "复制路径"}
          </button>
          <MarkButton link={link} file={file} line={at?.line ?? null} sessionId={pack.sessionId} />
          <button type="button" className="btn-ghost small dim" title="重新读取文件（R）" onClick={() => setReload((n) => n + 1)}>
            重新载入
            <kbd className="gr-key">R</kbd>
          </button>
        </div>
      </div>
      {item.note && <div className="vp-note">{item.note}</div>}
      {item.highlights.length > 0 && (
        <div className="vp-marks" role="list" aria-label="重点" data-testid="viewpack-marks" ref={bar}>
          {item.highlights.map((h, i) => (
            <button
              key={`${h.line}-${h.endLine ?? ""}-${i}`}
              type="button"
              role="listitem"
              className="vp-mark"
              aria-pressed={i === pressed}
              title={h.note || undefined}
              onClick={() => {
                setFocus(i);
                setPressed(i);
                setClicks((n) => n + 1);
                setRendered(false);
              }}
              data-testid="viewpack-mark"
            >
              <span className="vp-mark-where">{h.endLine ? `${h.line}–${h.endLine}` : h.line}</span>
              <span className="vp-mark-note">{h.note || "（没有说明）"}</span>
            </button>
          ))}
        </div>
      )}
      <div className="vw-file" data-testid="viewer-file">
        {code && loaded.state === "ok" ? (
          <FileReview
            key={`${loaded.file.path}#${reload}`}
            link={link}
            state={state}
            workspace={workspace}
            file={loaded.file}
            line={at?.line}
            endLine={at?.endLine}
            openKey={`${item.id}:${focus}:${clicks}:${nonce}`}
            defaultSession={pack.sessionId}
            active={active}
            highlights={marks}
            onActiveRow={onActiveRow}
          />
        ) : (
          <>
            {markdown && rendered && <FindBar active={active} container={renderedRef} />}
            <div className="vw-content" ref={renderedRef}>
              <FileContent link={link} file={file} loaded={loaded} rendered={rendered} reload={`${reload}:${nonce}`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
