import { createContext, useCallback, useContext, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { FileDiff } from "@amo-studio/protocol";
import { copyText, HostApiError, type HostLink } from "../host/client.js";
import { ActionMenu } from "../lib/ActionMenu.js";
import { MarkdownFileLinks } from "../lib/markdown.js";
import { isWebPage, openInApps, openInDefault, openInEditor, revealInExplorer, type FileRef } from "../lib/openin.js";
import { openReview } from "../gitreview/open.js";
import { markOrShow } from "../marks/open.js";
import { openViewer } from "../viewer/open.js";
import { useExistingPath } from "./exists.js";
import { parseInlinePath, parseLinkTarget } from "./paths.js";

// Files named in the conversation become links (stage 12, S12-C). Stage 13: a click opens the file in the viewer
// window (查看器; a change of this turn still opens in the quick look beside the conversation), Ctrl+click opens VS
// Code, and a right click offers 在查看器中打开 / 在侧栏预览 / 查看未提交的改动 / 用 VS Code 打开 / 在资源管理器中显示 /
// 复制路径 / 加书签, each with a letter (2026-10-28). A web page opens in the viewer too (2026-10-28; in the browser
// from 10-26), 用浏览器打开 on the menu. The page wraps its conversation in <FileLinks>; outside it, plain text.

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
  const browse = useCallback(
    (t: PreviewTarget) => {
      const ws = t.file.workspaceId ?? workspaceId;
      openInDefault(link, ws ? { path: t.file.path, workspaceId: ws } : { path: t.file.path }).catch(fail);
    },
    [link, workspaceId, fail],
  );
  // A web page too opens in the viewer (2026-10-28): rendered there, its passages take comments; the browser is on the menu.
  const open = useCallback((t: PreviewTarget) => (t.diff ? onPreview(t) : viewFile(t, workspaceId, sessionId)), [onPreview, workspaceId, sessionId]);
  const value = useMemo<FileLinksValue>(
    () => ({ link, workspaceId, sessionId, vscode, open, preview: onPreview, editor, menu: (e, target) => setMenu({ x: e.clientX, y: e.clientY, target }) }),
    [link, workspaceId, sessionId, vscode, open, onPreview, editor],
  );

  const t = menu?.target;
  const reviewIn = t ? (t.file.workspaceId ?? workspaceId) : null;
  const rendered = t && /\.(md|markdown|html?)$/i.test(t.file.path);

  return (
    <Ctx.Provider value={value}>
      <MarkdownFileLinks.Provider value={MentionLink}>{children}</MarkdownFileLinks.Provider>
      {menu && t && (
        // 2026-10-28: ways to look at it, then Explorer, then the path and 书签; a letter for each.
        <ActionMenu
          label="文件"
          at={menu}
          testId="file-menu"
          onClose={() => setMenu(null)}
          groups={[
            [
              {
                label: "在查看器中打开",
                key: "O",
                title: rendered ? "单独的窗口，渲染显示，可以选中文字写批注（单击文件名也是这样打开）" : "单独的窗口，可以按行写批注（单击文件名也是这样打开）",
                run: () => viewFile(t, workspaceId, sessionId),
              },
              { label: "在侧栏预览", key: "P", title: "在对话右边打开，不离开这段对话", run: () => onPreview(t) },
              {
                label: "查看未提交的改动",
                key: "D",
                disabled: !reviewIn,
                title: reviewIn ? "在这个项目的 Git Review 里看这个文件还没提交的改动" : "这段对话不属于任何项目",
                run: () => reviewIn && openReview({ workspaceId: reviewIn, ...(sessionId ? { sessionId } : {}), file: t.file.path }),
              },
              vscode && { label: "用 VS Code 打开", key: "V", title: "Ctrl+单击文件名也是这样打开", run: () => void openInEditor(link, t.file, t.line, t.column).catch(fail) },
              isWebPage(t.file.path) && { label: "用浏览器打开", key: "W", title: "在系统默认浏览器里打开", run: () => browse(t) },
            ],
            [{ label: "在资源管理器中显示", key: "E", run: () => void revealInExplorer(link, t.file).catch(fail) }],
            [
              { label: "复制路径", key: "C", run: () => void copyText(t.file.path) },
              { label: "加书签", key: "B", run: () => void markOrShow(link, t.file, t.line, sessionId ?? undefined).catch(fail) },
            ],
          ]}
        />
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
