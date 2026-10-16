import { GIT_RANGES, type GitChangedFile, type GitCommitChanges, type GitRange, type GitStatus } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { formatWhen } from "../attach/refs.js";
import { MarkButton } from "../marks/MarkButton.js";
import { openViewer } from "../viewer/open.js";
import { countLabel, STATUS_NAME, type DiffMode } from "./logic.js";

// The Review window's bars (stage 16 split out of ReviewApp.tsx): the head (what is compared, and how it shows) and
// the head of the file in front.

const MODES: { id: DiffMode; label: string }[] = [
  { id: "changes", label: "只看改动" },
  { id: "full", label: "完整文件" },
];

const LAYOUTS: { split: boolean; label: string; hint: string }[] = [
  { split: false, label: "单栏", hint: "新旧行上下排在一栏里" },
  { split: true, label: "左右对照", hint: "左边旧版，右边新版，两边一起滚动" },
];

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

/** The window's head: the commit or the branch, 历史, the range, 只看改动 / 完整文件, 单栏 / 左右对照, 刷新. */
export function ReviewHead({
  workspaceName,
  commit,
  shownCommit,
  status,
  range,
  mode,
  split,
  onHistory,
  onRange,
  onMode,
  onSplit,
  onRefresh,
}: {
  workspaceName: string;
  /** A commit's window. */
  commit: string | null;
  shownCommit: GitCommitChanges | null;
  status: GitStatus | undefined;
  range: GitRange;
  mode: DiffMode;
  split: boolean;
  onHistory(): void;
  onRange(range: GitRange): void;
  onMode(mode: DiffMode): void;
  onSplit(split: boolean): void;
  onRefresh(): void;
}) {
  return (
    <header className="gr-head">
      <span className="gr-title">{commit ? "提交" : "Git Review"}</span>
      <span className="gr-project">{workspaceName}</span>
      {commit && (
        <span className="gr-commit" data-testid="review-commit" title={shownCommit ? `${shownCommit.commit.sha}\n${shownCommit.commit.author} <${shownCommit.commit.email}>` : commit}>
          <code>{short(shownCommit?.commit.sha ?? commit)}</code>
          {shownCommit && (
            <>
              <span className="gr-commit-subject">{shownCommit.commit.subject}</span>
              <span className="gr-dim">
                {shownCommit.commit.author} · {formatWhen(shownCommit.commit.date)}
                {shownCommit.commit.parents.length > 1 ? " · 合并提交，对比第一个父提交" : shownCommit.commit.parents.length === 0 ? " · 第一个提交" : ""}
              </span>
            </>
          )}
        </span>
      )}
      {status?.repo && (
        <span className="gr-branch" data-testid="review-branch" title={status.root}>
          {status.branch ?? `分离的 HEAD ${short(status.head)}`}
          {range === "branch" && (status.base ? ` · 对比 ${status.base}（基点 ${short(status.mergeBase)}）` : " · 没有找到默认分支，同工作区改动")}
        </span>
      )}
      <span className="spacer" />
      {(commit || status?.repo) && (
        <button type="button" className="btn-ghost small" onClick={onHistory} title="这个分支的提交（h）：搜索说明、hash 或作者，在新窗口查看" data-testid="review-history">
          历史
        </button>
      )}
      {!commit && (
        <div className="gr-seg" role="group" aria-label="对比范围">
          {GIT_RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id} title={r.hint} onClick={() => onRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
      <div className="gr-seg" role="group" aria-label="显示方式">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => onMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="gr-seg" role="group" aria-label="版式">
        {LAYOUTS.map((l) => (
          <button key={l.label} type="button" aria-pressed={split === l.split} title={l.hint} onClick={() => onSplit(l.split)}>
            {l.label}
          </button>
        ))}
      </div>
      {!commit && (
        <button
          type="button"
          className="btn-ghost small"
          onClick={onRefresh}
          title="重新读取改动"
        >
          刷新
        </button>
      )}
    </header>
  );
}

/** The file in front: its path and state, and where else to open it. */
export function FileHead({
  link,
  workspaceId,
  file,
  vscode,
  openLine,
  lineChosen,
  onOpen,
}: {
  link: HostLink;
  workspaceId: string;
  file: GitChangedFile;
  /** VS Code is on this machine. */
  vscode: boolean;
  /** The line VS Code and the viewer open at. */
  openLine: number;
  /** A line was moved to or clicked (the mark takes it). */
  lineChosen: boolean;
  onOpen(app: "vscode" | "explorer", line?: number): void;
}) {
  return (
    <div className="gr-file-head" data-testid="review-file-head">
      <span className="gr-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
      <span className="gr-dim">{file.untracked ? "未跟踪的新文件" : STATUS_NAME[file.status]}</span>
      <span className="spacer" />
      <span className="gr-dim">{countLabel(file)}</span>
      {vscode && (
        <button
          type="button"
          className="btn-ghost small"
          disabled={file.status === "deleted"}
          title={file.status === "deleted" ? "文件已删除" : `在 VS Code 里打开到第 ${openLine} 行`}
          onClick={() => onOpen("vscode", openLine)}
          data-testid="review-open-vscode"
        >
          VS Code 打开
        </button>
      )}
      <button
        type="button"
        className="btn-ghost small"
        disabled={file.status === "deleted"}
        title={file.status === "deleted" ? "文件已删除" : "在资源管理器里选中这个文件"}
        onClick={() => onOpen("explorer")}
        data-testid="review-reveal"
      >
        在资源管理器中显示
      </button>
      {file.status !== "deleted" && (
        <button
          type="button"
          className="btn-ghost small"
          title={`在查看器里看这个文件现在的样子（第 ${openLine} 行）`}
          onClick={() => openViewer({ path: file.path, workspaceId, line: openLine })}
          data-testid="review-open-viewer"
        >
          查看文件
        </button>
      )}
      {file.status !== "deleted" && <MarkButton link={link} file={{ path: file.path, workspaceId }} line={lineChosen ? openLine : null} />}
    </div>
  );
}
