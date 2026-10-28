import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { PREVIEW_IMAGE_TYPES, type FileDiff, type TextFile } from "@amo-studio/protocol";
import { copyText, HostApiError, type HostLink } from "../host/client.js";
import { CodeTokens } from "../lib/CodeTokens.js";
import { languageForPath, type CodeToken } from "../lib/highlight.js";
import { useWorkerHighlight } from "../lib/useWorkerHighlight.js";
import { Markdown, MarkdownFileLinks } from "../lib/markdown.js";
import { openInEditor, rawFileUrl, readTextFile, revealInExplorer, type FileRef } from "../lib/openin.js";
import { formatBytes } from "../attach/refs.js";
import { diffRows, type DiffRow } from "./changes.js";
import { useVsCode } from "./FileLinks.js";
import { fileName, folderOf } from "./paths.js";

// The quick look (stage 12, S12-C, after DSH's document preview): a file beside the conversation without leaving it.
// Code with line numbers and colours, scrolled to and marking a line; Markdown rendered or as source; images; a
// change first when given (本轮改动). Reusable: the page decides where it sits and adds its own actions. Stage 13: the
// file itself (FileContent, useTextFile) is shared with the viewer window.

export interface FilePreviewProps {
  link: HostLink;
  /** Absolute, or relative to the project `workspaceId`. */
  file: FileRef;
  /** 1-based line to scroll to and mark (through `endLine` when given). */
  line?: number | undefined;
  endLine?: number | undefined;
  column?: number | undefined;
  /** A change to show first (本轮改动); "打开文件" switches to the file as it is now. */
  diff?: FileDiff | undefined;
  onClose(): void;
  /** More buttons for the header (after 复制路径). */
  extraActions?: ReactNode;
}

const WIDTH_KEY = "amo.filePreview.width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 520;
/** Fixed row height of the code view (it only renders the rows in sight). */
const ROW_H = 20;
const OVERSCAN = 30;

const maxWidth = () => Math.max(MIN_WIDTH, Math.min(1100, window.innerWidth - 420));
function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= MIN_WIDTH ? Math.min(v, maxWidth()) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export const isImage = (path: string) => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && !!PREVIEW_IMAGE_TYPES[path.slice(dot).toLowerCase()];
};

export type Loaded = { state: "loading" } | { state: "ok"; file: TextFile } | { state: "error"; message: string };

/** The file's text from the Host; `enabled` false asks nothing (an image, or a change shown instead). */
export function useTextFile(link: HostLink, file: FileRef, enabled: boolean, reload: number | string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoaded({ state: "loading" });
    readTextFile(link, file)
      .then((f) => live && setLoaded({ state: "ok", file: f }))
      .catch((err: unknown) => {
        if (!live) return;
        const message = err instanceof HostApiError && err.status === 404 ? "找不到这个文件，可能已被删除或移动。" : err instanceof HostApiError ? err.message : String(err);
        setLoaded({ state: "error", message });
      });
    return () => {
      live = false;
    };
  }, [link, file.path, file.workspaceId, enabled, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return loaded;
}

/** Whether the loaded file is Markdown text, which can show rendered or as source. */
export const isMarkdownText = (path: string, loaded: Loaded) => languageForPath(path) === "markdown" && loaded.state === "ok" && loaded.file.text !== undefined;
/** Whether the loaded file is HTML text, which the viewer can show rendered (渲染批注, 2026-10-28). */
export const isHtmlText = (path: string, loaded: Loaded) => languageForPath(path) === "html" && loaded.state === "ok" && loaded.file.text !== undefined && !loaded.file.tooLarge;

/**
 * A file as it is now: an image, Markdown rendered (or its source), or code with line numbers and colours, scrolled to
 * and marking `line` (through `endLine`).
 */
export function FileContent({
  link,
  file,
  loaded,
  line,
  endLine,
  rendered,
  reload,
}: {
  link: HostLink;
  file: FileRef;
  loaded: Loaded;
  line?: number | undefined;
  endLine?: number | undefined;
  rendered: boolean;
  reload: number | string;
}) {
  if (isImage(file.path))
    return (
      <div className="fp-image">
        <img src={`${rawFileUrl(link, file)}&v=${reload}`} alt={fileName(file.path)} data-testid="file-preview-image" />
      </div>
    );
  if (loaded.state === "loading") return <div className="fp-empty">读取中…</div>;
  if (loaded.state === "error")
    return (
      <div className="fp-empty" role="alert">
        {loaded.message}
      </div>
    );
  if (loaded.file.binary) return <div className="fp-empty">这是二进制文件（{formatBytes(loaded.file.size)}），不能预览。</div>;
  if (loaded.file.tooLarge || loaded.file.text === undefined) return <div className="fp-empty">文件太大（{formatBytes(loaded.file.size)}），不能预览。可以用编辑器打开。</div>;
  if (languageForPath(file.path) === "markdown" && rendered)
    return (
      <div className="fp-md">
        <MarkdownFileLinks.Provider value={null}>
          <Markdown source={loaded.file.text} />
        </MarkdownFileLinks.Provider>
      </div>
    );
  return <CodeView key={`${loaded.file.path}#${reload}`} text={loaded.file.text} path={file.path} line={line} endLine={endLine} />;
}

export function FilePreview({ link, file, line, endLine, column, diff, onClose, extraActions }: FilePreviewProps) {
  const vscode = useVsCode(link);
  const [width, setWidth] = useState(savedWidth);
  const [mode, setMode] = useState<"diff" | "file">(diff ? "diff" : "file");
  const [at, setAt] = useState<{ line?: number | undefined; endLine?: number | undefined; column?: number | undefined }>({ line, endLine, column });
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const image = isImage(file.path);
  const loaded = useTextFile(link, file, mode === "file" && !image, reload);
  const [rendered, setRendered] = useState(!line);

  useEffect(() => {
    setMode(diff ? "diff" : "file");
    setAt({ line, endLine, column });
    setRendered(!line);
  }, [file.path, file.workspaceId, line, endLine, column, diff]);

  // Esc closes the preview, unless a menu, a dialog or a list is open (they take Esc first) or the person is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('.ctx-menu, .model-menu, .usage-panel, [role="dialog"], [role="listbox"]')) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.matches("input, textarea, select, [contenteditable]") && !el.closest(".file-preview")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const absolute = loaded.state === "ok" ? loaded.file.path : file.path;
  const markdown = isMarkdownText(file.path, loaded);
  const fail = (err: unknown) => setNotice(err instanceof HostApiError ? err.message : String(err));

  // Dragging the left edge resizes the panel (kept on this machine).
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(MIN_WIDTH, Math.min(maxWidth(), startW + (startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
      } catch {
        // not kept: fine
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const showFile = (l?: number) => {
    setAt({ line: l });
    setRendered(!l);
    setMode("file");
  };

  return (
    <aside className="file-preview" aria-label="文件预览" data-testid="file-preview" style={{ width }}>
      <div className="fp-resize" role="separator" aria-orientation="vertical" aria-label="调整预览宽度" onPointerDown={startResize} />
      <div className="fp-head">
        <div className="fp-title">
          <span className="fp-name" title={absolute} data-testid="file-preview-name">
            {fileName(file.path)}
            {mode === "file" && at.line && !(markdown && rendered) ? <span className="fp-line-no">:{at.line}</span> : null}
          </span>
          <span className="fp-dir" title={absolute}>
            {folderOf(absolute)}
          </span>
        </div>
        <button type="button" className="icon-btn fp-close" aria-label="关闭预览" title="关闭预览（Esc）" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="fp-actions">
        {vscode && (
          <button type="button" className="btn-ghost small" data-testid="fp-vscode" onClick={() => openInEditor(link, file, mode === "file" ? at.line : undefined, mode === "file" ? at.column : undefined).catch(fail)}>
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
        {extraActions}
        <span className="spacer" />
        {mode === "file" && (
          <button type="button" className="btn-ghost small dim" title="重新读取文件" onClick={() => setReload((n) => n + 1)}>
            重新载入
          </button>
        )}
      </div>
      {(diff || (markdown && mode === "file")) && (
        <div className="fp-modes">
          {diff && (
            <div className="fp-seg" role="group" aria-label="查看">
              <button type="button" aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>
                本轮改动
              </button>
              <button type="button" aria-pressed={mode === "file"} disabled={diff.change === "delete"} title={diff.change === "delete" ? "这个文件在这一轮被删除了" : "看文件现在的样子"} onClick={() => showFile(firstChangedLine(diff))}>
                打开文件
              </button>
            </div>
          )}
          {markdown && mode === "file" && <RenderedToggle rendered={rendered} onChange={setRendered} />}
        </div>
      )}
      {notice && (
        <div className="fp-notice" role="status">
          {notice}
        </div>
      )}
      <div className="fp-body">
        {mode === "diff" && diff ? (
          <DiffBody diff={diff} path={file.path} onLine={(l) => showFile(l)} />
        ) : (
          <FileContent link={link} file={file} loaded={loaded} line={at.line} endLine={at.endLine} rendered={rendered} reload={reload} />
        )}
      </div>
    </aside>
  );
}

/** 渲染 / 源码 for a Markdown (or, in the viewer, an HTML) file. */
export function RenderedToggle({ rendered, onChange, label = "Markdown" }: { rendered: boolean; onChange(rendered: boolean): void; label?: string }) {
  return (
    <div className="fp-seg" role="group" aria-label={label}>
      <button type="button" aria-pressed={rendered} onClick={() => onChange(true)}>
        渲染
      </button>
      <button type="button" aria-pressed={!rendered} onClick={() => onChange(false)}>
        源码
      </button>
    </div>
  );
}

/** The first line a change touches in the new file (where "打开文件" scrolls to). */
function firstChangedLine(diff: FileDiff): number | undefined {
  return diffRows(diff).find((r) => r.kind === "add" && r.newLine)?.newLine;
}

/**
 * Highlights `texts` as one piece of code (so strings and comments spanning lines colour right), in the highlight
 * worker (2026-10-20: on the window's thread, up to 5000 lines); null while it works, or when too long.
 */
function useHighlighted(texts: readonly string[], path: string): ReadonlyArray<readonly CodeToken[] | null> | null {
  const code = useMemo(() => texts.join("\n"), [texts]);
  return useWorkerHighlight(code, languageForPath(path), 0);
}

/** A file's text with line numbers, rendering only the rows in sight; scrolls to and marks `line` (through `endLine`). */
function CodeView({ text, path, line, endLine }: { text: string; path: string; line?: number | undefined; endLine?: number | undefined }) {
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  const tokens = useHighlighted(lines, path);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const last = line ? Math.max(line, endLine ?? line) : 0;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // A range that fits shows whole, a third of the way down; a longer one starts near the top.
    const span = (last - (line ?? 0) + 1) * ROW_H;
    const lead = span < el.clientHeight * 0.6 ? el.clientHeight / 3 : ROW_H * 2;
    el.scrollTop = line ? Math.max(0, (line - 1) * ROW_H - lead) : 0;
    setView({ top: el.scrollTop, height: el.clientHeight });
  }, [line, last, text]);

  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  const gutter = `${String(lines.length).length + 1}ch`;
  return (
    <div className="fp-code" ref={box} data-testid="file-preview-code" data-highlighted={tokens ? "" : undefined} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
      <div className="fp-code-inner" style={{ height: lines.length * ROW_H }}>
        <div className="fp-rows" style={{ transform: `translateY(${first * ROW_H}px)` }}>
          {lines.slice(first, end).map((l, k) => {
            const n = first + k + 1;
            const marked = !!line && n >= line && n <= last;
            const edge = marked ? `${n === line ? " first" : ""}${n === last ? " last" : ""}` : "";
            return (
              <div key={n} className={`fp-row${marked ? ` marked${edge}` : ""}`} data-line={n} style={{ height: ROW_H }}>
                <span className="fp-gutter" style={{ width: gutter }}>
                  {n}
                </span>
                <span className="fp-text">
                  <CodeTokens tokens={tokens?.[n - 1]} text={l} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A change of this turn, coloured by line; a click on a line opens the file there. */
function DiffBody({ diff, path, onLine }: { diff: FileDiff; path: string; onLine(line: number): void }) {
  const rows = useMemo(() => diffRows(diff), [diff]);
  const texts = useMemo(() => rows.map((r) => (r.kind === "hunk" ? "" : r.text)), [rows]);
  const tokens = useHighlighted(texts, path);
  // A long change shows its start; the rest on request (2026-10-20: every row was drawn).
  const [all, setAll] = useState(false);
  if (!rows.length) return <div className="fp-empty">这一轮的记录里没有这个文件的改动内容。</div>;
  const shown = all ? rows : rows.slice(0, DIFF_SHOWN);
  return (
    <div className="fp-diff" data-testid="file-preview-diff">
      <div className="fp-diff-stat">
        {diff.change === "add" ? "新文件 · " : diff.change === "delete" ? "已删除 · " : ""}
        <span className="add">+{diff.added}</span> <span className="del">−{diff.removed}</span>
      </div>
      {shown.map((r: DiffRow, i) => (
        <div
          key={i}
          className={`fp-diff-row ${r.kind}${r.newLine ? " jump" : ""}`}
          title={r.newLine ? `第 ${r.newLine} 行 · 点击在文件里查看` : undefined}
          onClick={r.newLine ? () => onLine(r.newLine!) : undefined}
        >
          <span className="fp-gutter">{r.kind === "hunk" ? "" : (r.newLine ?? "")}</span>
          <span className="fp-diff-mark" aria-hidden="true">
            {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
          </span>
          <span className="fp-text">{r.kind === "hunk" ? r.text : <CodeTokens tokens={tokens?.[i]} text={r.text || " "} />}</span>
        </div>
      ))}
      {shown.length < rows.length && (
        <button type="button" className="show-all" onClick={() => setAll(true)} data-testid="show-all">
          还有 {rows.length - shown.length} 行 · 显示全部
        </button>
      )}
    </div>
  );
}

/** Rows of a change shown before 显示全部. */
const DIFF_SHOWN = 400;
