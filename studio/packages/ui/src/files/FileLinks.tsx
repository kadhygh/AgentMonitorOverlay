import { createContext, useCallback, useContext, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { FileDiff } from "@amo-studio/protocol";
import { copyText, HostApiError, type HostLink } from "../host/client.js";
import { MarkdownFileLinks } from "../lib/markdown.js";
import { openInApps, openInEditor, revealInExplorer, type FileRef } from "../lib/openin.js";
import { openReview } from "../gitreview/open.js";
import { markOrShow } from "../marks/open.js";
import { openViewer } from "../viewer/open.js";
import { useExistingPath } from "./exists.js";
import { parseInlinePath, parseLinkTarget } from "./paths.js";

// Files named in the conversation become links (stage 12, S12-C). Stage 13: a click opens the file in the viewer
// window (查看器; a change of this turn still opens in the quick look beside the conversation), Ctrl+click opens VS
// Code, and a right click offers 查看器打开 / 右栏快速查看 / 用 git diff 看 / VS Code 打开 / 在资源管理器中显示 /
// 复制路径 / 标记. The page wraps its conversation in <FileLinks>; outside one, everything stays plain text.

/** What the quick look shows: a file (at a line or range), or a change to it first (本轮改动). */
export interface PreviewTarget {
  file: FileRef;
  line?: number;
  endLine?: number;
  column?: number;
  diff?: FileDiff;
}

interface FileLinksValue {
  link: HostLink;
  workspaceId: string | null;
  sessionId: string | null;
  vscode: boolean;
  /** A click: the viewer window, or the quick look for a change of this turn. */
  open(target: PreviewTarget): void;
  preview(target: PreviewTarget): void;
  editor(target: PreviewTarget): void;
  menu(e: MouseEvent, target: PreviewTarget): void;
}

const Ctx = createContext<FileLinksValue | null>(null);

/** The surrounding <FileLinks>, or null outside one. */
export const useFileLinks = () => useContext(Ctx);

type Menu = { x: number; y: number; target: PreviewTarget } | null;

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

/** The viewer window at the file (and its line or range); relative names start from `workspaceId`'s folder. */
export function viewFile(t: PreviewTarget, workspaceId: string | null, sessionId: string | null = null): void {
  const ws = t.file.workspaceId ?? workspaceId;
  openViewer({
    path: t.file.path,
    ...(ws ? { workspaceId: ws } : {}),
    ...(t.line ? { line: t.line, ...(t.endLine ? { endLine: t.endLine } : {}) } : {}),
    // The conversation it was opened from: comments written in the viewer go back there by default (S14-A).
    ...(sessionId ? { sessionId } : {}),
  });
}

/** Whether this machine has VS Code (false until known). */
export function useVsCode(link: HostLink): boolean {
  const [vscode, setVscode] = useState(false);
  useEffect(() => {
    if (!link.url) return;
    let live = true;
    openInApps(link)
      .then((a) => live && setVscode(a.vscode))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link]);
  return vscode;
}

export function FileLinks({
  link,
  workspaceId,
  sessionId = null,
  onPreview,
  onError,
  children,
}: {
  link: HostLink;
  /** Relative names start from this project's folder. */
  workspaceId: string | null;
  /** The conversation's session (Review opened from a turn's changes sends comments back to it). */
  sessionId?: string | null;
  onPreview(target: PreviewTarget): void;
  onError?(text: string): void;
  children: ReactNode;
}) {
  const vscode = useVsCode(link);
  const [menu, setMenu] = useState<Menu>(null);

  const fail = useCallback((err: unknown) => onError?.(message(err)), [onError]);
  const editor = useCallback(
    (t: PreviewTarget) => {
      if (!vscode) return viewFile(t, workspaceId, sessionId);
      openInEditor(link, t.file, t.line, t.column).catch(fail);
    },
    [vscode, link, workspaceId, sessionId, fail],
  );
  const open = useCallback((t: PreviewTarget) => (t.diff ? onPreview(t) : viewFile(t, workspaceId, sessionId)), [onPreview, workspaceId, sessionId]);
  const value = useMemo<FileLinksValue>(
    () => ({ link, workspaceId, sessionId, vscode, open, preview: onPreview, editor, menu: (e, target) => setMenu({ x: e.clientX, y: e.clientY, target }) }),
    [link, workspaceId, sessionId, vscode, open, onPreview, editor],
  );

  // The menu closes on Escape, on a click outside it, and when anything scrolls.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    const onDown = (e: globalThis.MouseEvent) => !(e.target as Element | null)?.closest?.(".file-menu") && close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const act = (fn: (t: PreviewTarget) => void) => () => {
    if (!menu) return;
    const t = menu.target;
    setMenu(null);
    fn(t);
  };
  const reviewIn = menu ? (menu.target.file.workspaceId ?? workspaceId) : null;

  return (
    <Ctx.Provider value={value}>
      <MarkdownFileLinks.Provider value={MentionLink}>{children}</MarkdownFileLinks.Provider>
      {menu && (
        <div className="ctx-menu file-menu" role="menu" aria-label="文件" style={{ left: menu.x, top: menu.y }} data-testid="file-menu">
          <button type="button" role="menuitem" onClick={act((t) => viewFile(t, workspaceId, sessionId))}>
            查看器打开
          </button>
          <button type="button" role="menuitem" onClick={act(onPreview)}>
            右栏快速查看
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!reviewIn}
            title={reviewIn ? "在这个项目的 Git Review 里看这个文件未提交的改动" : "这段对话不属于任何项目"}
            onClick={act((t) => reviewIn && openReview({ workspaceId: reviewIn, ...(sessionId ? { sessionId } : {}), file: t.file.path }))}
          >
            用 git diff 看
          </button>
          {vscode && (
            <button type="button" role="menuitem" onClick={act((t) => openInEditor(link, t.file, t.line, t.column).catch(fail))}>
              VS Code 打开
            </button>
          )}
          <button type="button" role="menuitem" onClick={act((t) => revealInExplorer(link, t.file).catch(fail))}>
            在资源管理器中显示
          </button>
          <button type="button" role="menuitem" onClick={act((t) => void copyText(t.file.path))}>
            复制路径
          </button>
          <button type="button" role="menuitem" onClick={act((t) => void markOrShow(link, t.file, t.line).catch(fail))}>
            标记
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}

/**
 * A file name that becomes a link once the Host says the file exists (until then, and when it does not, `fallback`
 * or the children show as they are). `nested` renders a span for use inside a button (a tool row).
 */
export function FileLink({
  path,
  line,
  endLine,
  column,
  cwd,
  nested,
  className,
  fallback,
  testId = "file-link",
  children,
}: {
  path: string;
  line?: number | undefined;
  /** The last line of a range (`a.cs:12-20`): the viewer marks them all. */
  endLine?: number | undefined;
  column?: number | undefined;
  /** Where a relative name starts, when not the project folder (a tool call's working directory). */
  cwd?: string | undefined;
  nested?: boolean;
  className?: string;
  fallback?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const ctx = useFileLinks();
  const found = useExistingPath(ctx?.link ?? null, { workspaceId: ctx?.workspaceId ?? null, cwd }, ctx ? path : null);
  if (!ctx || !found || found.dir) return <>{fallback ?? children}</>;
  const range = !!line && !!endLine && endLine > line;
  const target: PreviewTarget = { file: { path: found.path }, ...(line ? { line, ...(range ? { endLine } : {}) } : {}), ...(line && column ? { column } : {}) };
  const where = `${found.path}${line ? `:${line}${range ? `-${endLine}` : column ? `:${column}` : ""}` : ""}`;
  const open = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) ctx.editor(target);
    else ctx.open(target);
  };
  const props = {
    className: `file-link${className ? ` ${className}` : ""}`,
    role: "link",
    "data-testid": testId,
    "data-file-link": "",
    "data-path": found.path,
    title: `${where}\n点击在查看器里打开${ctx.vscode ? " · Ctrl+点击用 VS Code 打开" : ""} · 右键更多`,
    onClick: open,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.menu(e, target);
    },
  };
  return nested ? (
    <span {...props}>{children}</span>
  ) : (
    <a
      {...props}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e);
      }}
    >
      {children}
    </a>
  );
}

/** Inline code or a Markdown link in a reply: a file link when it names an existing file. */
function MentionLink({ kind, target, children, fallback }: { kind: "code" | "link"; target: string; children: ReactNode; fallback: ReactNode }) {
  const mention = kind === "code" ? parseInlinePath(target) : parseLinkTarget(target);
  if (!mention) return <>{fallback}</>;
  return (
    <FileLink path={mention.path} line={mention.line} endLine={mention.endLine} column={mention.column} fallback={fallback} className={kind === "code" ? "file-link-code" : "md-link"}>
      {children}
    </FileLink>
  );
}
