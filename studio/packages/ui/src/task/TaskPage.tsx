import { useEffect, useState } from "react";
import { TASK_COLUMNS, type ApprovalDecision, type ModelProfile, type Session, type Task, type TaskColumn, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { shortModel } from "../lib/profiles.js";
import { COLUMN_NAMES } from "../lib/status.js";
import { SessionTree } from "./SessionTree.js";
import { Thread } from "./Thread.js";
import { AnnotationPanel } from "./AnnotationPanel.js";
import type { SelectionAnchor } from "../lib/selection.js";

interface TaskPageProps {
  link: HostLink;
  task: Task;
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  initialSessionId?: string;
  onBack(): void;
}

type Toast = { text: string; command?: string; error?: boolean } | null;

const WRITER = {
  workbench: { label: "仅工作台", color: "var(--text-dim)" },
  "terminal-shared": { label: "终端已接入 · 共享", color: "var(--running-text)" },
  "terminal-handoff": { label: "已交给终端 · 只读", color: "var(--attention)" },
  archived: { label: "已归档 · 只读", color: "var(--text-dim)" },
} as const;

/** Task page: session tree | conversation with composer. Annotations and the scratchpad join in stage 2. */
export function TaskPage({ link, task, sessions, workspaces, profiles, initialSessionId, onBack }: TaskPageProps) {
  const own = sessions.filter((s) => s.taskId === task.id);
  const [selected, setSelected] = useState<string | null>(initialSessionId ?? own.find((s) => !s.archivedAt)?.id ?? null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAnnotation, setPendingAnnotation] = useState<SelectionAnchor | null>(null);

  useEffect(() => {
    if (!selected || !own.some((s) => s.id === selected)) {
      const first = own.find((s) => !s.archivedAt);
      if (first) setSelected(first.id);
    }
  }, [selected, own]);

  const session = own.find((s) => s.id === selected) ?? null;
  const { items } = useSessionItems(link, session?.id ?? null);
  const profile = (id: string) => profiles.find((p) => p.id === id);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";
  const isArea = task.scope.kind === "area";
  const scopeLabel = task.scope.kind === "area" ? "跨工作区" : wsName(task.scope.workspaceId);

  async function run<T>(fn: () => Promise<T>, onDone?: (value: T) => void) {
    setBusy(true);
    try {
      const value = await fn();
      onDone?.(value);
    } catch (err) {
      setToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const setColumn = (column: TaskColumn) => run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { column }));
  const newSession = (input: { profileId: string; workspaceId?: string }) =>
    run(() => call(link, "POST /api/tasks/:id/sessions", { id: task.id }, input), (s) => setSelected(s.id));
  const restore = (id: string) => run(() => call(link, "POST /api/sessions/:id/unarchive", { id }), () => setSelected(id));
  const archive = (id: string) =>
    run(() => call(link, "POST /api/sessions/:id/archive", { id }), () => {
      const next = own.find((s) => !s.archivedAt && s.id !== id && s.parentId !== id);
      setSelected(next?.id ?? null);
    });
  const fork = (id: string) => run(() => call(link, "POST /api/sessions/:id/fork", { id }, {}), (s) => setSelected(s.id));
  const openTerminal = (id: string) =>
    run(() => call(link, "POST /api/sessions/:id/terminal", { id }, { launch: true }), (r) =>
      setToast({ text: "已在新终端窗口接入同一会话。两边实时同步，都可以输入。", command: r.command }),
    );

  const approve = (approvalId: string, decision: ApprovalDecision) =>
    session ? run(() => call(link, "POST /api/approvals/:approvalId", { approvalId }, { sessionId: session.id, decision })) : Promise.resolve();
  const interrupt = (id: string) => run(() => call(link, "POST /api/sessions/:id/interrupt", { id }));
  async function send(text: string): Promise<boolean> {
    if (!session) return false;
    try {
      await call(link, "POST /api/sessions/:id/messages", { id: session.id }, { text });
      return true;
    } catch (err) {
      setToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return false;
    }
  }
  const writer = session ? WRITER[session.writer] : null;

  return (
    <section className="taskpage" aria-label="任务">
      <div className="page-head">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← 看板
        </button>
        <h1 className="task-title" data-testid="task-title">
          {task.title || "未命名任务"}
        </h1>
        <span className="page-crumb">{scopeLabel}</span>
        <span className="spacer" />
        <label className="inline-field">
          任务状态
          <select value={task.column} onChange={(e) => void setColumn(e.target.value as TaskColumn)} data-testid="task-column">
            {TASK_COLUMNS.map((c) => (
              <option key={c} value={c}>
                {COLUMN_NAMES[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {toast && (
        <div role="status" className={toast.error ? "toast toast-error" : "toast"} data-testid="toast">
          <span>{toast.text}</span>
          {toast.command && <code>{toast.command}</code>}
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}

      <div className="task-body">
        <SessionTree
          task={task}
          sessions={own}
          workspaces={workspaces}
          profiles={profiles}
          selected={selected}
          busy={busy}
          onSelect={setSelected}
          onNewSession={(input) => void newSession(input)}
          onRestore={(id) => void restore(id)}
        />
        <div className="thread-col">
          {session && (
            <div className="thread-head" data-testid="thread-head">
              <span className="thread-title">{session.title || "新会话"}</span>
              <span className="page-crumb">
                {shortModel(profile(session.profileId))}
                {isArea ? ` · ${wsName(session.workspaceId)}` : ""}
              </span>
              <span className="spacer" />
              {writer && (
                <span className="writer" style={{ color: writer.color }} data-testid="writer">
                  {writer.label}
                </span>
              )}
              {!session.archivedAt && session.runtime === "codex" && (
                <button type="button" className="btn-ghost small" disabled={busy || !session.runtimeRef} onClick={() => void openTerminal(session.id)}>
                  在终端打开
                </button>
              )}
              {!session.archivedAt && (
                <button type="button" className="btn-ghost small dim" disabled={busy || !session.runtimeRef} onClick={() => void fork(session.id)}>
                  分支
                </button>
              )}
              {!session.archivedAt ? (
                <button type="button" className="btn-ghost small dim" disabled={busy} onClick={() => void archive(session.id)}>
                  归档
                </button>
              ) : (
                <button type="button" className="btn-ghost small primary" disabled={busy} onClick={() => void restore(session.id)}>
                  恢复
                </button>
              )}
            </div>
          )}
          <Thread
            session={session}
            items={items}
            model={shortModel(session ? profile(session.profileId) : undefined)}
            busy={busy}
            onApprove={(item, decision) => void approve(item.approvalId, decision)}
            onJump={setSelected}
            onSend={send}
            onInterrupt={() => session && void interrupt(session.id)}
            onAnnotate={setPendingAnnotation}
          />
        </div>
        <AnnotationPanel
          pending={pendingAnnotation}
          busy={busy}
          onCancel={() => setPendingAnnotation(null)}
          onSave={(note) => {
            if (!session || !pendingAnnotation) return;
            const anchor = pendingAnnotation;
            void run(() => call(link, "POST /api/sessions/:id/annotations", { id: session.id }, { ...anchor, note }), () => {
              setPendingAnnotation(null);
              setToast({ text: "已添加批注。" });
            });
          }}
        />
      </div>
    </section>
  );
}
