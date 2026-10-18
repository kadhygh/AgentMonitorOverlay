import { useState } from "react";
import type { Session } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { openMarks } from "../marks/open.js";
import { CopyId } from "../lib/CopyId.js";
import { WorkdirActions } from "../files/WorkdirActions.js";
import { ArchiveIcon, formatDay } from "./Archived.js";
import { EditableName } from "./EditableName.js";
import { PopMenu, below, type Anchor } from "./TaskHead.js";

// The bar over a session's conversation and the banners under it (stage 16 split out of TaskPage.tsx).

const WRITER = {
  workbench: { label: "仅工作台", color: "var(--text-dim)" },
  "terminal-shared": { label: "终端已接入 · 共享", color: "var(--running-text)" },
  "terminal-handoff": { label: "已交给终端 · 只读", color: "var(--attention)" },
  archived: { label: "已归档 · 只读", color: "var(--text-dim)" },
} as const;

/** The session's name and model, who writes to it, and its actions: open outside, 在终端打开, 分支, more. */
export function SessionHead({
  link,
  session,
  model,
  workdir,
  busy,
  onRename,
  onTerminal,
  onFork,
  onArchive,
  onError,
}: {
  link: HostLink;
  session: Session;
  /** The model as shown ("Opus 5.5 · 高"). */
  model: string;
  /** The folder the session works in. */
  workdir: string | undefined;
  busy: boolean;
  onRename(title: string): void;
  onTerminal(): void;
  onFork(): void;
  onArchive(): void;
  onError(text: string): void;
}) {
  const [sessionMenu, setSessionMenu] = useState<Anchor | null>(null);
  const writer = WRITER[session.writer];
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
      <CopyId id={session.id} label="会话" className="thread-id" testId="session-id" />
      {/* 仅工作台 is the usual case and says nothing; the other writers matter. */}
      {writer && !session.archivedAt && session.writer !== "workbench" && (
        <span className="writer" style={{ color: writer.color }} data-testid="writer">
          {writer.label}
        </span>
      )}
      <span className="spacer" />
      {/* Where the session works, opened outside Studio: editor, folder, terminal. */}
      <span className="bar-group" role="group" aria-label="在外部打开">
        {workdir && <WorkdirActions link={link} path={workdir} onError={onError} compact />}
        {/* DSH sessions (stage 17) have no terminal of their own to hand to, and no fork. */}
        {!session.archivedAt && session.writer !== "terminal-handoff" && session.runtime !== "dsh" && !(session.runtime === "claude" && session.kind === "sub") && (
          <button
            type="button"
            className="bar-btn"
            aria-label="在终端打开"
            title={session.runtime === "claude" ? "在终端打开：交给终端里的 Claude 继续，工作台暂时只读" : "在终端打开：终端接入同一会话，两边都能输入"}
            disabled={busy || !session.runtimeRef || (session.runtime === "claude" && session.status === "running")}
            onClick={onTerminal}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d="m4.2 6.2 2.3 1.8-2.3 1.8M8.3 10.2h3.2" />
            </svg>
          </button>
        )}
      </span>
      {!session.archivedAt && session.runtime !== "dsh" && !(session.runtime === "claude" && session.kind === "sub") && (
        <>
          <span className="head-sep" aria-hidden="true" />
          <button type="button" className="bar-btn labeled" aria-label="分支" title="分支：从这里分出一个新会话，原会话不受影响" disabled={busy || !session.runtimeRef} onClick={onFork} data-testid="session-fork">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="4.5" cy="3.5" r="1.7" />
              <circle cx="4.5" cy="12.5" r="1.7" />
              <circle cx="11.5" cy="5" r="1.7" />
              <path d="M4.5 5.2v5.6M11.5 6.7c0 2.8-3.4 2.9-6.2 4.3" />
            </svg>
            <span className="bar-label">分支</span>
          </button>
        </>
      )}
      <button type="button" className="bar-btn" aria-label="会话的更多操作" title="更多：文件标记、归档会话" onClick={(e) => setSessionMenu(below(e.currentTarget))} data-testid="session-more">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="filled">
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {sessionMenu && (
        <PopMenu at={sessionMenu} label="会话" onClose={() => setSessionMenu(null)} testId="session-menu">
          <button
            type="button"
            role="menuitem"
            title="文件标记：拖进输入框或 @ 引用"
            onClick={() => {
              setSessionMenu(null);
              openMarks({ workspaceId: session.workspaceId });
            }}
            data-testid="session-marks"
          >
            文件标记
          </button>
          {/* An archived session is restored from its banner below. */}
          {!session.archivedAt && (
            <button
              type="button"
              role="menuitem"
              className="menu-danger"
              disabled={busy}
              onClick={() => {
                setSessionMenu(null);
                onArchive();
              }}
              data-testid="session-archive"
            >
              归档会话
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
