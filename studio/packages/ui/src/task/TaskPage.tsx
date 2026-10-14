import { useEffect, useState } from "react";
import { TASK_COLUMNS, taskWhere, type Annotation, type ApprovalDecision, type ChecklistItem, type PresetDraft, type ModelProfile, type Session, type SessionOptions, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { useAnnotations } from "../review/useAnnotations.js";
import { shortModel } from "../lib/profiles.js";
import { COLUMN_NAMES } from "../lib/status.js";
import { SessionTree } from "./SessionTree.js";
import { Thread } from "./Thread.js";
import { flash } from "./ReplyNav.js";
import { REVEAL_ITEM_EVENT } from "../chat/Transcript.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { AnnotationPanel } from "../review/AnnotationPanel.js";
import { MailPanel, useTaskMail } from "../collab/MailPanel.js";
import { DecisionPanel, useOpenDecisions } from "../collab/DecisionPanel.js";
import { NotesPanel, useTaskNotes } from "../collab/NotesPanel.js";
import { PackDocsPanel } from "../packs/PackDocsPanel.js";
import { ChecklistPanel } from "../collab/ChecklistPanel.js";
import { EditableName } from "./EditableName.js";
import { usePacks } from "../packs/usePacks.js";
import { useFeature } from "../lib/features.js";
import { PresetDraftForm } from "../packs/PresetDraftForm.js";
import type { SelectionAnchor } from "../lib/selection.js";
import { openReview, useIsGitRepo } from "../gitreview/open.js";
import { latestMainSession } from "../gitreview/logic.js";
import { OnCanvasToggle } from "../canvas/OnCanvasToggle.js";
import { openMarks } from "../marks/open.js";
import { MarkButton } from "../marks/MarkButton.js";
import { FileLinks, type PreviewTarget } from "../files/FileLinks.js";
import { FilePreview } from "../files/FilePreview.js";
import { WorkdirActions } from "../files/WorkdirActions.js";

interface TaskPageProps {
  link: HostLink;
  task: Task;
  sessions: readonly Session[];
  /** All tasks (mail shows which task it came from). */
  tasks?: readonly Task[];
  workspaces: readonly Workspace[];
  topics?: readonly Topic[];
  profiles: readonly ModelProfile[];
  /** This task's checklist (from a pack template). */
  checklist?: readonly ChecklistItem[];
  initialSessionId?: string;
  /** What "←" says: where it returns (看板 or 画布). */
  backLabel?: string;
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
export function TaskPage({ link, task, sessions, tasks = [task], workspaces, topics = [], profiles, checklist = [], initialSessionId, backLabel = "看板", onBack }: TaskPageProps) {
  const own = sessions.filter((s) => s.taskId === task.id);
  const [selected, setSelected] = useState<string | null>(initialSessionId ?? own.find((s) => !s.archivedAt)?.id ?? null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAnnotation, setPendingAnnotation] = useState<SelectionAnchor | null>(null);
  // The quick look of a file named in the conversation (stage 12); it takes the right column while open.
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  useEffect(() => {
    if (!selected || !own.some((s) => s.id === selected)) {
      const first = own.find((s) => !s.archivedAt);
      if (first) setSelected(first.id);
    }
  }, [selected, own]);

  const session = own.find((s) => s.id === selected) ?? null;
  const settings = useSettings(link);
  const { items } = useSessionItems(link, session?.id ?? null);
  const annotations = useAnnotations(link, session?.id ?? null);
  const profile = (id: string) => profiles.find((p) => p.id === id);
  const scopeLabel = taskWhere(task, workspaces);
  const liveTopics = topics.filter((t) => !t.archivedAt || t.id === task.topicId);
  // Git Review: only for a project under git.
  const gitRepo = useIsGitRepo(link, task.workspaceId);

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
  /** 转移: into another topic, or out of its topic (null). */
  const setTopic = (topicId: string | null) =>
    run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { topicId }), () => setToast({ text: topicId ? "已转到这个专题。" : "已移出专题。" }));
  const archiveTask = () =>
    run(() => call(link, task.archivedAt ? "POST /api/tasks/:id/unarchive" : "POST /api/tasks/:id/archive", { id: task.id }), (t) =>
      setToast({ text: t.archivedAt ? "任务和它的会话都已归档。" : "任务已恢复。" }),
    );
  const newSession = (input: { profileId: string; options?: SessionOptions }) =>
    run(() => call(link, "POST /api/tasks/:id/sessions", { id: task.id }, input), (s) => setSelected(s.id));
  const openPreset = (key: string) => {
    const [workspaceId, pack, preset] = key.split("/") as [string, string, string];
    void run(() => call(link, "POST /api/workspaces/:id/packs/:pack/presets/:preset/draft", { id: workspaceId, pack, preset }, { taskId: task.id }), setDraft);
  };
  const startPreset = (d: PresetDraft, input: { profileId: string; text: string }) =>
    run(
      () => call(link, "POST /api/tasks/:id/sessions", { id: task.id }, { profileId: input.profileId, text: input.text }),
      (s) => {
        setDraft(null);
        setSelected(s.id);
      },
    );
  const restore = (id: string) => run(() => call(link, "POST /api/sessions/:id/unarchive", { id }), () => setSelected(id));
  const archive = (id: string) =>
    run(() => call(link, "POST /api/sessions/:id/archive", { id }), () => {
      const next = own.find((s) => !s.archivedAt && s.id !== id && s.parentId !== id);
      setSelected(next?.id ?? null);
    });
  const fork = (id: string) => run(() => call(link, "POST /api/sessions/:id/fork", { id }, {}), (s) => setSelected(s.id));
  const openTerminal = (s: Session) =>
    run(() => call(link, "POST /api/sessions/:id/terminal", { id: s.id }, { launch: true }), (r) =>
      setToast(
        s.runtime === "claude"
          ? { text: "已交给新终端窗口里的 Claude。工作台暂时只读，关闭终端后会自动收回。" }
          : { text: "已在新终端窗口接入同一会话。两边实时同步，都可以输入。", command: r.command },
      ),
    );
  const reclaim = (id: string) => run(() => call(link, "POST /api/sessions/:id/reclaim", { id }));
  const mail = useTaskMail(link, task, sessions);
  const decisions = useOpenDecisions(link);
  const notes = useTaskNotes(link, task.id);
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  // The extension packs of the task's own project.
  const packsOn = useFeature("packs");
  const { packs } = usePacks(link, packsOn ? [task.workspaceId] : []);
  const presetChoices = packs.flatMap((p) =>
    p.manifest ? p.manifest.presets.map((pr) => ({ key: `${p.workspaceId}/${p.dirName}/${pr.id}`, label: `${p.manifest!.title} · ${pr.title}` })) : [],
  );
  const unread = new Map<string, number>();
  for (const m of mail) if (m.state === "unread" && m.to.kind === "session") unread.set(m.to.sessionId, (unread.get(m.to.sessionId) ?? 0) + 1);
  const forwardMail = (m: { id: string }, sessionId: string) =>
    run(() => call(link, "POST /api/mail/:id/forward", { id: m.id }, { sessionId }), () => {
      setSelected(sessionId);
      setToast({ text: "已把留言转进对话。" });
    });
  const dismissMail = (m: { id: string }) => run(() => call(link, "PATCH /api/mail/:id", { id: m.id }, { state: "dismissed" }));

  const readOnly = !session || session.writer === "archived" || session.writer === "terminal-handoff";

  /** Scrolls to the annotated block of a reply and flashes it. */
  function locate(a: Annotation, retry = true) {
    const reply = document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(a.itemId)}"]`);
    if (!reply) {
      // A reply between steps hides in a folded turn: unfold it, then look again once it has rendered.
      if (!retry) return;
      window.dispatchEvent(new CustomEvent(REVEAL_ITEM_EVENT, { detail: a.itemId }));
      requestAnimationFrame(() => requestAnimationFrame(() => locate(a, false)));
      return;
    }
    const blocks = [...reply.querySelectorAll<HTMLElement>("[data-src-start]")];
    const target =
      blocks.find((b) => Number(b.dataset.srcStart) < a.end && Number(b.dataset.srcEnd) > a.start) ??
      blocks.find((b) => b.textContent?.includes(a.quote)) ??
      reply;
    target.scrollIntoView({ block: "center" });
    flash(target);
  }

  const approve = (approvalId: string, decision: ApprovalDecision) =>
    session ? run(() => call(link, "POST /api/approvals/:approvalId", { approvalId }, { sessionId: session.id, decision })) : Promise.resolve();
  const interrupt = (id: string) => run(() => call(link, "POST /api/sessions/:id/interrupt", { id }));
  async function send(text: string, attachments: string[]): Promise<boolean> {
    if (!session) return false;
    try {
      await call(link, "POST /api/sessions/:id/messages", { id: session.id }, { text, ...(attachments.length ? { attachments } : {}) });
      return true;
    } catch (err) {
      setToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return false;
    }
  }
  const writer = session ? WRITER[session.writer] : null;
  const workdir = session ? workspaces.find((w) => w.id === session.workspaceId)?.path : undefined;
  const showError = (text: string) => setToast({ text, error: true });

  return (
    <section className="taskpage" aria-label="任务">
      <div className="page-head">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← {backLabel}
        </button>
        <h1 className="task-title" data-testid="task-title">
          <EditableName
            value={task.title}
            placeholder="未命名任务"
            label="任务名"
            disabled={!!task.archivedAt}
            onSave={(title) => void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { title }))}
          />
        </h1>
        <span className="page-crumb">{scopeLabel}</span>
        {task.archivedAt && <span className="page-crumb">已归档</span>}
        <span className="spacer" />
        <label className="inline-field">
          专题
          <select
            value={task.topicId ?? ""}
            onChange={(e) => void setTopic(e.target.value || null)}
            disabled={!!task.archivedAt || busy}
            data-testid="task-topic"
            title="转移：放进另一个专题，或移出专题"
          >
            <option value="">不在专题里</option>
            {liveTopics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {gitRepo && (
          <button
            type="button"
            className="btn-ghost small"
            title="Git Review：查看项目的改动并逐行批注"
            onClick={() => {
              const main = latestMainSession(sessions, task.id);
              openReview({ workspaceId: task.workspaceId, ...(main ? { sessionId: main.id } : {}) });
            }}
            data-testid="task-review"
          >
            Review
          </button>
        )}
        <button type="button" className="btn-ghost small" title="文件标记：这个项目标记的文件（Ctrl+Shift+M）" onClick={() => openMarks({ workspaceId: task.workspaceId })} data-testid="task-marks">
          标记
        </button>
        {task.topicId && (
          <OnCanvasToggle
            key={task.topicId}
            link={link}
            taskId={task.id}
            topicId={task.topicId}
            disabled={!!task.archivedAt}
            onError={(text) => setToast({ text, error: true })}
          />
        )}
        <button type="button" className="btn-ghost small" onClick={() => void archiveTask()} disabled={busy} data-testid="task-archive">
          {task.archivedAt ? "恢复任务" : "归档任务"}
        </button>
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
          link={link}
          task={task}
          sessions={own}
          workspaces={workspaces}
          profiles={profiles}
          selected={selected}
          busy={busy}
          onSelect={setSelected}
          onNewSession={(input) => void newSession(input)}
          onRestore={(id) => void restore(id)}
          unread={unread}
          presets={presetChoices}
          onPreset={openPreset}
        />
        <div className="thread-col">
          {draft && (
            <PresetDraftForm
              key={`${draft.workspaceId}/${draft.presetId}`}
              draft={draft}
              profiles={profiles}
              busy={busy}
              onStart={(input) => void startPreset(draft, input)}
              onCancel={() => setDraft(null)}
            />
          )}
          {session && (
            <div className="thread-head" data-testid="thread-head">
              <span className="thread-title">
                <EditableName
                  value={session.title}
                  placeholder="新会话"
                  label="会话名"
                  disabled={!!session.archivedAt}
                  onSave={(title) => void run(() => call(link, "PATCH /api/sessions/:id", { id: session.id }, { title }))}
                />
              </span>
              <span className="page-crumb">
                {shortModel(profile(session.profileId))}
              </span>
              {workdir && <WorkdirActions link={link} path={workdir} onError={showError} />}
              <span className="spacer" />
              {writer && (
                <span className="writer" style={{ color: writer.color }} data-testid="writer">
                  {writer.label}
                </span>
              )}
              {gitRepo && (
                <button type="button" className="btn-ghost small" title="Git Review：批注发回这个会话" onClick={() => openReview({ workspaceId: session.workspaceId, sessionId: session.id })} data-testid="session-review">
                  Review
                </button>
              )}
              <button type="button" className="btn-ghost small" title="文件标记：拖进输入框或 @ 引用" onClick={() => openMarks({ workspaceId: session.workspaceId })} data-testid="session-marks">
                标记
              </button>
              {!session.archivedAt && session.writer !== "terminal-handoff" && !(session.runtime === "claude" && session.kind === "sub") && (
                <button
                  type="button"
                  className="btn-ghost small"
                  disabled={busy || !session.runtimeRef || (session.runtime === "claude" && session.status === "running")}
                  onClick={() => void openTerminal(session)}
                >
                  在终端打开
                </button>
              )}
              {!session.archivedAt && !(session.runtime === "claude" && session.kind === "sub") && (
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
          {session?.writer === "terminal-handoff" && (
            <div className="handoff-banner" role="status" data-testid="handoff-banner">
              <span>
                这个会话正在终端里的 Claude 中继续。为避免两边同时写入丢失内容，工作台暂时只读；关闭终端后会自动收回，并带回终端里的新内容。
              </span>
              <button type="button" className="btn-outline-attention" disabled={busy} onClick={() => void reclaim(session.id)}>
                立即收回
              </button>
            </div>
          )}
          <FileLinks link={link} workspaceId={session?.workspaceId ?? task.workspaceId} sessionId={session?.id ?? null} onPreview={setPreview} onError={showError}>
            <Thread
              link={link}
              presets={settings?.presets ?? []}
              session={session}
              {...(session && profile(session.profileId) ? { profile: profile(session.profileId)! } : {})}
              tasks={tasks}
              sessions={sessions}
              items={items}
              model={shortModel(session ? profile(session.profileId) : undefined)}
              busy={busy}
              onApprove={(item, decision) => void approve(item.approvalId, decision)}
              onJump={setSelected}
              onSend={send}
              onInterrupt={() => session && void interrupt(session.id)}
              onAnnotate={(anchor) => {
                setPreview(null);
                setPendingAnnotation(anchor);
              }}
              onError={showError}
              annotations={annotations}
              decisions={session ? decisions.filter((d) => d.sessionId === session.id) : []}
            />
          </FileLinks>
        </div>
        {/* While open, the quick look takes the right column (files.css hides the annotation panel beside it). */}
        {preview && (
          <FilePreview
            link={link}
            file={preview.file}
            line={preview.line}
            column={preview.column}
            diff={preview.diff}
            onClose={() => setPreview(null)}
            extraActions={<MarkButton link={link} file={preview.file} line={preview.line} className="btn-ghost small" />}
          />
        )}
        <AnnotationPanel
          header={
            <>
            <DecisionPanel decisions={decisions} task={task} current={session?.id ?? null} sessionTitle={(id) => sessions.find((s) => s.id === id)?.title || "会话"} onOpen={setSelected} />
            <MailPanel
              mail={mail}
              sessions={sessions}
              tasks={tasks}
              current={session ?? null}
              busy={busy}
              onForward={(m, sessionId) => void forwardMail(m, sessionId)}
              onDismiss={(m) => void dismissMail(m)}
            />
            <ChecklistPanel link={link} items={checklist} sessions={sessions} />
            <NotesPanel link={link} taskId={task.id} notes={notes} sessions={sessions} />
            <PackDocsPanel link={link} packs={packs} />
            </>
          }
          link={link}
          annotations={annotations}
          pending={pendingAnnotation}
          busy={busy}
          canSend={!readOnly}
          onEdit={(id, note) => void run(() => call(link, "PATCH /api/annotations/:id", { id }, { note }))}
          onDelete={(id) => void run(() => call(link, "DELETE /api/annotations/:id", { id }))}
          onLocate={locate}
          onSendAll={() => {
            if (!session) return;
            void run(() => call(link, "POST /api/sessions/:id/annotations/send", { id: session.id }), (r) =>
              setToast({ text: `已把 ${r.sent.length} 条批注汇总发回会话。` }),
            );
          }}
          onCancel={() => setPendingAnnotation(null)}
          onSave={(note) => {
            if (!session || !pendingAnnotation) return;
            const anchor = pendingAnnotation;
            void run(() => call(link, "POST /api/sessions/:id/annotations", { id: session.id }, { ...anchor, note }), () => {
              setPendingAnnotation(null);
            });
          }}
        />
      </div>
    </section>
  );
}
