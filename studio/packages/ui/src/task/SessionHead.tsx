import { useState } from "react";
import type { Session } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { openMarks } from "../marks/open.js";
import { CopyId } from "../lib/CopyId.js";
import { openInEditor, revealInExplorer } from "../lib/openin.js";
import { useVsCode } from "../files/FileLinks.js";
import { ArchiveIcon, formatDay } from "./Archived.js";
import { EditableName } from "./EditableName.js";
import { PopMenu, below, folderIcon, type Anchor } from "./TaskHead.js";

// The bar over a session's conversation and the banners under it (stage 16 split out of TaskPage.tsx).

const WRITER = {
  workbench: { label: "仅工作台", color: "var(--text-dim)" },
  "terminal-shared": { label: "终端已接入 · 共享", color: "var(--running-text)" },
  "terminal-handoff": { label: "已交给终端 · 只读", color: "var(--attention)" },
  archived: { label: "已归档 · 只读", color: "var(--text-dim)" },
} as const;

/**
 * The session's name and model, who writes to it, and its actions: 追踪, 分支, 归档, and ⋯ (VS Code, 资源管理器, 在终端打开,
 * 书签, 绑定到待办).
 */
export function SessionHead({
  link,
  session,
  topicId,
  model,
  project,
  workdir,
  busy,
  tracked,
  onTrack,
  onRename,
  onTerminal,
  onFork,
  forkRuntime = session.runtime,
  forkOff,
  onArchive,
  onError,
  onBindTodo,
}: {
  link: HostLink;
  session: Session;
  /** The task's topic: where 书签 opens. */
  topicId?: string | null;
  /** The model as shown ("Opus 5.5 · 高"). */
  model: string;
  /**
   * The project the session works in, by name (2026-11-09, the user: session 也要显示属于哪个 project; a session can be
   * in another one than its task's): null for the common folder; absent where it is not known (an older remote computer).
   */
  project?: string | null;
  /** The folder the session works in. */
  workdir: string | undefined;
  busy: boolean;
  /** 追踪 (2026-11-03, 问题 #15): the task is pinned in Focus (focus/pins.ts), the same list Focus's own 置顶 keeps. */
  tracked?: boolean;
  /** Absent where Focus would not show the task (an archived one). */
  onTrack?(): void;
  onRename(title: string): void;
  onTerminal(): void;
  onFork(): void;
  /** 远程分支 (2026-11-12): a copy's runtime on the computer it runs on, and why 分支 is greyed (that Studio is too old). */
  forkRuntime?: Session["runtime"];
  forkOff?: string;
  onArchive(): void;
  onError(text: string): void;
  /** 绑定到待办 (问题 #10): absent where it cannot be done (a plain browser, a remote task's copy). */
  onBindTodo?(): void;
}) {
  const [sessionMenu, setSessionMenu] = useState<Anchor | null>(null);
  const writer = WRITER[session.writer];
  // 远程 (step 2): a copy of another computer's session — its folder, terminal and branches are there
  // (its name and 归档 too, but they are done from here: sent there, 2026-10-30).
  const remote = session.runtime === "remote";
  const vscode = useVsCode(link);
  const fail = (err: unknown) => onError(err instanceof HostApiError ? err.message : String(err));
  const dir = remote ? undefined : workdir;
  // DSH shows it greyed (2026-11-10, the user: 灰掉就行); a Claude subagent has no conversation of its own.
  // A copy's (2026-11-12) is made on the computer it runs on; its subagents and delegated sessions follow their parent there.
  const canFork = !session.archivedAt && !(remote && session.kind === "sub") && !(forkRuntime === "claude" && session.kind === "sub");
  // DSH sessions (stage 17) have no terminal of their own to hand to, and no fork.
  const terminal = !session.archivedAt && !remote && session.writer !== "terminal-handoff" && session.runtime !== "dsh" && !(session.runtime === "claude" && session.kind === "sub");
  const pick = (f: () => void) => () => {
    setSessionMenu(null);
    f();
  };
  return (
    <div className="thread-head" data-testid="thread-head">
      <span className="thread-title">
        <EditableName
          value={session.title}
          placeholder="新会话"
          label="会话名"
          disabled={!!session.archivedAt}
          onSave={onRename}
        />
      </span>
      <span className="thread-model" data-testid="thread-model">
        {model}
      </span>
      {project !== undefined && (
        <span className="thread-project" title={project ? `项目：${project}${remote ? "（在那台电脑上）" : ""}${dir ? `
${dir}` : ""}` : `在公共目录里运行${dir ? `：${dir}` : ""}`} data-testid="session-project">
          {folderIcon}
          <span className="thread-project-name">{project ?? "未指定项目"}</span>
        </span>
      )}
      <CopyId id={session.id} label="会话" className="thread-id" testId="session-id" />
      {/* 仅工作台 is the usual case and says nothing; the other writers matter. */}
      {writer && !session.archivedAt && session.writer !== "workbench" && (
        <span className="writer" style={{ color: writer.color }} data-testid="writer">
          {writer.label}
        </span>
      )}
      <span className="spacer" />
      {/* 追踪 (2026-11-03, 问题 #15): the same as 置顶 in Focus — the task stays on top there; the button shows whether it
          is. VS Code, 资源管理器 and 在终端打开 went into ⋯ to make room (the user's call, same issue). */}
      {onTrack && (
        <button
          type="button"
          className={tracked ? "bar-btn labeled track on" : "bar-btn labeled track"}
          aria-pressed={!!tracked}
          aria-label="在 Focus 里追踪"
          title={tracked ? "追踪中：这个任务置顶在 Focus 最上面。点一下取消" : "追踪：把这个任务置顶在 Focus 最上面（和在 Focus 里点置顶一样）"}
          onClick={onTrack}
          data-testid="session-track"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="5.6" />
            <circle cx="8" cy="8" r="2.1" className={tracked ? "dot on" : "dot"} />
            <path d="M8 .9v2.2M8 12.9v2.2M.9 8h2.2M12.9 8h2.2" />
          </svg>
          <span className="bar-label">{tracked ? "追踪中" : "追踪"}</span>
        </button>
      )}
      {/* 归档 out of ⋯ (2026-10-28; 分支 went into ⋯ 2026-11-10); an archived session is restored from its banner below. */}
      {/* A remote task's session is archived on its own computer too (2026-10-30). */}
      {!session.archivedAt && (
        <button type="button" className="bar-btn labeled soft-danger" aria-label="归档会话" title="归档会话：变成只读，从它开出的分支一起归档；之后可以恢复" disabled={busy} onClick={onArchive} data-testid="session-archive">
          <ArchiveIcon />
          <span className="bar-label">归档</span>
        </button>
      )}
      <button
        type="button"
        className="bar-btn"
        aria-label="会话的更多操作"
        title={["更多", [canFork && "分支", dir && vscode && "VS Code", dir && "资源管理器", terminal && "在终端打开", "书签", onBindTodo && "绑定到待办"].filter(Boolean).join("、")].join("：")}
        onClick={(e) => setSessionMenu(below(e.currentTarget))}
        data-testid="session-more"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="filled">
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {sessionMenu && (
        <PopMenu at={sessionMenu} label="会话" onClose={() => setSessionMenu(null)} testId="session-menu">
          {/* 分支 (on the bar until 2026-11-10): from the latest turn; each turn has its own under its reply. */}
          {canFork && (
            <>
              <button
                type="button"
                role="menuitem"
                title={forkOff ?? (forkRuntime === "dsh" ? "DeepSeek 会话不能分支：DSH 不支持" : "从最新一轮分出一个新会话，原会话不受影响；也可以点每轮回复下面的分支图标")}
                disabled={busy || !session.runtimeRef || forkRuntime === "dsh" || !!forkOff}
                onClick={pick(onFork)}
                data-testid="session-fork"
              >
                从最新一轮分支…
              </button>
              {/* Said in the menu, not only on hover (2026-11-12): why a remote task's 分支 is greyed. */}
              {forkOff && (
                <span className="menu-note fork-off-note" data-testid="session-fork-off">
                  {forkOff}
                </span>
              )}
              <div className="menu-sep" role="separator" />
            </>
          )}
          {/* Where the session works, opened outside Studio (on the bar until 2026-11-03, 问题 #15). */}
          {dir && vscode && (
            <button type="button" role="menuitem" title={`VS Code 打开文件夹：${dir}`} onClick={pick(() => void openInEditor(link, { path: dir }).catch(fail))} data-testid="session-vscode">
              VS Code 打开文件夹
            </button>
          )}
          {dir && (
            <button type="button" role="menuitem" title={`在资源管理器中显示：${dir}`} onClick={pick(() => void revealInExplorer(link, { path: dir }).catch(fail))} data-testid="session-explorer">
              在资源管理器中显示
            </button>
          )}
          {terminal && (
            <button
              type="button"
              role="menuitem"
              title={session.runtime === "claude" ? "交给终端里的 Claude 继续，工作台暂时只读" : "终端接入同一会话，两边都能输入"}
              disabled={busy || !session.runtimeRef || (session.runtime === "claude" && session.status === "running")}
              onClick={pick(onTerminal)}
              data-testid="session-terminal"
            >
              在终端打开
            </button>
          )}
          {(!!dir || terminal) && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            title="书签：这个专题记下的文件和对话片段，可以拖进输入框"
            onClick={pick(() => openMarks({ topicId: topicId ?? "none", workspaceId: session.workspaceId, ...(session.taskId ? { taskId: session.taskId } : {}) }))}
            data-testid="session-marks"
          >
            书签
          </button>
          {onBindTodo && (
            <button type="button" role="menuitem" title="选一条便签里的待办绑定到这个会话：在待办里点它就回到这里" onClick={pick(onBindTodo)} data-testid="session-bind-todo">
              绑定到待办…
            </button>
          )}
        </PopMenu>
      )}
    </div>
  );
}

/** Under the bar: an archived session (restore it), or one handed to a terminal (take it back). */
export function SessionBanners({ session, taskArchived, busy, onRestore, onReclaim }: { session: Session; taskArchived: boolean; busy: boolean; onRestore(): void; onReclaim(): void }) {
  return (
    <>
      {session.archivedAt && !taskArchived && (
        <div className="archived-banner" role="status" data-testid="session-archived-banner">
          <ArchiveIcon />
          <span className="archived-banner-text">
            <b>已归档 · 只读</b>
            <span>{formatDay(session.archivedAt)} 归档。这个会话只能查看，恢复后才能继续。</span>
          </span>
          <button type="button" className="btn-primary small" disabled={busy} onClick={onRestore} data-testid="session-unarchive">
            恢复会话
          </button>
        </div>
      )}
      {session.writer === "terminal-handoff" && (
        <div className="handoff-banner" role="status" data-testid="handoff-banner">
          <span>
            这个会话正在终端里的 Claude 中继续。为避免两边同时写入丢失内容，工作台暂时只读；关闭终端后会自动收回，并带回终端里的新内容。
          </span>
          <button type="button" className="btn-outline-attention" disabled={busy} onClick={onReclaim}>
            立即收回
          </button>
        </div>
      )}
    </>
  );
}
