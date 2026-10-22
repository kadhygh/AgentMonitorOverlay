import { useEffect, useMemo, useRef, useState } from "react";
import type { StateSnapshot } from "@amo-studio/protocol";
import { copyText, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { openInEditor, revealInExplorer, type FileRef } from "../lib/openin.js";
import { showToast } from "../lib/toast.js";
import { FileContent, isImage, isMarkdownText, RenderedToggle, useTextFile } from "../files/FilePreview.js";
import { useVsCode } from "../files/FileLinks.js";
import { fileName, folderOf } from "../files/paths.js";
import { ReviewPage } from "../gitreview/ReviewApp.js";
import { useIsGitRepo } from "../gitreview/open.js";
import { MarkButton } from "../marks/MarkButton.js";
import { FindBar } from "../gitreview/FindBar.js";
import { sessionChoices } from "../gitreview/logic.js";
import { FileReview } from "./FileReview.js";
import { linesLabel, parseViewerHash, projectOf, type ViewerMode, type ViewerTarget } from "./logic.js";
import { pinViewer, viewerPinned } from "./open.js";

// The viewer window (查看器, stage 13; #viewer?path=…): a file opened from a conversation, a mark or a Review, in one
// of two modes. 文件: the file as it is now (code coloured, the asked line or range marked and scrolled to; Markdown
// rendered or as source; images). 改动: the project's Git Review at that file. The window is the preview one, reused
// for the next file, until 固定 keeps it. Stage 14 (S14-A): code in 文件 mode takes line comments like Review
// (FileReview), Ctrl+G goes to a line, Ctrl+F finds; the two modes stay laid out while hidden, so each keeps its place.

export function ViewerApp() {
  const host = useHostState();
  const [target, setTarget] = useState<ViewerTarget | null>(() => parseViewerHash(location.hash));
  // The preview window is reused: another file arrives as a new hash.
  useEffect(() => {
    const on = () => setTarget(parseViewerHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (host.kind !== "ready") return <div className="placeholder">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</div>;
  if (!target) return <div className="placeholder">没有要查看的文件。</div>;
  return <ViewerPage link={host.link} state={host.state} target={target} />;
}

const MODES: { id: ViewerMode; label: string; hint: string }[] = [
  { id: "file", label: "文件", hint: "文件现在的样子" },
  { id: "changes", label: "改动", hint: "这个项目未提交的改动（Git Review），选中这个文件" },
];

function ViewerPage({ link, state, target }: { link: HostLink; state: StateSnapshot; target: ViewerTarget }) {
  const workspace = projectOf(target.path, state.workspaces, target.workspaceId);
  const file: FileRef = { path: target.path, ...(target.workspaceId && workspace?.id === target.workspaceId ? { workspaceId: target.workspaceId } : {}) };
  const repo = useIsGitRepo(link, workspace?.id);
  const vscode = useVsCode(link);
  const [mode, setMode] = useState<ViewerMode>(target.mode ?? "file");
  // 改动 stays mounted once shown (a comment being written survives a look at the file).
  const [changesShown, setChangesShown] = useState(target.mode === "changes");
  const [rendered, setRendered] = useState(!target.line);
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Every open is a fresh read, including the same path after the agent saved another edit.
  const readVersion = `${reload}:${target.nonce ?? ""}`;
  const loaded = useTextFile(link, file, !isImage(file.path), readVersion);
  const absolute = loaded.state === "ok" ? loaded.file.path : file.path;
  const markdown = isMarkdownText(file.path, loaded);

  // Another file (or the same one again): back to its mode, its line, rendered unless a line was asked for.
  const openKey = `${target.path}\u0000${target.line ?? ""}\u0000${target.endLine ?? ""}\u0000${target.nonce ?? ""}`;
  useEffect(() => {
    const m = target.mode ?? "file";
    setMode(m);
    if (m === "changes") setChangesShown(true);
    setRendered(!target.line);
  }, [openKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void viewerPinned().then(setPinned).catch(() => undefined);
  }, []);
  useEffect(() => {
    document.title = `${fileName(target.path)} · 查看器`;
  }, [target.path]);

  const fail = (err: unknown) => showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
  const pick = (m: ViewerMode) => {
    setMode(m);
    if (m === "changes") setChangesShown(true);
  };
  const where = linesLabel(target.line, target.endLine);
  // Code (not an image, not Markdown shown rendered) is drawn by FileReview: comments, Ctrl+G, Ctrl+F.
  const code = loaded.state === "ok" && !isImage(file.path) && !loaded.file.binary && !loaded.file.tooLarge && loaded.file.text !== undefined && !(markdown && rendered);
  // Comments go to the conversation that opened the file, else the project's most recently active session; fixed
  // per open, so sessions updating does not move the choice.
  const defaultSession = useMemo(
    () => target.sessionId ?? (workspace ? (sessionChoices(state, workspace.id)[0]?.id ?? null) : null),
    [openKey, workspace?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rendered_ = useRef<HTMLDivElement>(null);

  return (
    <div className="vw-app" data-testid="viewer" data-mode={mode}>
      <header className="vw-head">
        <div className="gr-seg" role="group" aria-label="查看方式">
          {MODES.map((m) => {
            const off = m.id === "changes" && (!workspace || !repo);
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={mode === m.id}
                disabled={off}
                title={off ? (workspace ? `${workspace.name} 不是 git 仓库` : "这个文件不在任何项目里") : m.hint}
                onClick={() => pick(m.id)}
                data-testid={`viewer-mode-${m.id}`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <div className="vw-title">
          <span className="vw-name" title={absolute} data-testid="viewer-name">
            {fileName(target.path)}
          </span>
          {where && mode === "file" && !(markdown && rendered) && (
            <span className="vw-lines" data-testid="viewer-lines">
              {where}
            </span>
          )}
          <span className="vw-dir" title={absolute}>
            {workspace ? `${workspace.name} · ` : ""}
            {folderOf(absolute)}
          </span>
        </div>
        {/* The file's actions in 文件 mode; 改动 has its own on the file's head. */}
        <div className="vw-actions">
          {mode === "file" && (
            <>
              {markdown && <RenderedToggle rendered={rendered} onChange={setRendered} />}
              {code && (
                <button
                  type="button"
                  className="btn-ghost small dim"
                  title="跳到行（Ctrl+G）；查找（Ctrl+F）"
                  onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true }))}
                  data-testid="viewer-goto"
                >
                  跳到行
                </button>
              )}
              {vscode && (
                <button type="button" className="btn-ghost small" onClick={() => openInEditor(link, file, target.line).catch(fail)} data-testid="viewer-vscode">
                  VS Code 打开
                </button>
              )}
              <button type="button" className="btn-ghost small" onClick={() => revealInExplorer(link, file).catch(fail)} data-testid="viewer-reveal">
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
              <MarkButton link={link} file={file} line={target.line ?? null} sessionId={target.sessionId ?? null} />
              <button type="button" className="btn-ghost small dim" title="重新读取文件" onClick={() => setReload((n) => n + 1)}>
                重新载入
              </button>
            </>
          )}
          <button
          type="button"
          className="btn-ghost small vw-pin"
          aria-pressed={pinned}
          disabled={pinned}
          title={pinned ? "已固定：这个窗口会保留，之后点开的文件在新窗口里" : "固定这个窗口：之后点开的文件会在新窗口里打开，这个窗口保留"}
          onClick={() =>
            void pinViewer()
              .then(setPinned)
              .catch(fail)
          }
          data-testid="viewer-pin"
        >
          {pinned ? "已固定" : "固定"}
          </button>
        </div>
      </header>
      <main className="vw-body">
        <div className="vw-file" hidden={mode !== "file"} data-testid="viewer-file">
          {code && loaded.state === "ok" ? (
            <FileReview
              key={`${loaded.file.path}#${reload}`}
              link={link}
              state={state}
              workspace={workspace}
              file={loaded.file}
              line={target.line}
              endLine={target.endLine}
              openKey={openKey}
              defaultSession={defaultSession}
              active={mode === "file"}
            />
          ) : (
            <>
              {/* Rendered Markdown: Ctrl+F finds in the text on the page. */}
              {markdown && rendered && <FindBar active={mode === "file"} container={rendered_} />}
              <div className="vw-content" ref={rendered_}>
                <FileContent link={link} file={file} loaded={loaded} line={target.line} endLine={target.endLine} rendered={rendered} reload={readVersion} />
              </div>
            </>
          )}
        </div>
        {changesShown && workspace && (
          <div className="vw-changes" hidden={mode !== "changes"}>
            <ReviewPage
              key={workspace.id}
              link={link}
              state={state}
              workspace={workspace}
              sessionId={defaultSession}
              select={{ path: absolute, nonce: target.nonce ?? "" }}
              embedded
              inactive={mode !== "changes"}
            />
          </div>
        )}
      </main>
    </div>
  );
}
