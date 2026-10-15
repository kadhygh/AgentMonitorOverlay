import { useEffect, useState } from "react";
import { type Annotation, type ApprovalDecision, type ChecklistItem, type PresetDraft, type ModelProfile, type Session, type SessionOptions, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { useAnnotations } from "../review/useAnnotations.js";
import { shortModel } from "../lib/profiles.js";
import { sessionModelName, useProfileChoices } from "../lib/choices.js";
import { SessionTree } from "./SessionTree.js";
import { Thread } from "./Thread.js";
import { flash } from "./ReplyNav.js";
import { flashAnnotation } from "../review/highlights.js";
import { REVEAL_ITEM_EVENT } from "../chat/Transcript.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { showToast } from "../lib/toast.js";
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
import { openReview, useIsGitRepo } from "../gitreview/open.js";
import { latestMainSession } from "../gitreview/logic.js";
import { OnCanvasToggle } from "../canvas/OnCanvasToggle.js";
import { openMarks } from "../marks/open.js";
import { MarkButton } from "../marks/MarkButton.js";
import { FileLinks, type PreviewTarget } from "../files/FileLinks.js";
import { FilePreview } from "../files/FilePreview.js";
import { WorkdirActions } from "../files/WorkdirActions.js";
import { ArchiveIcon, formatDay, TaskArchivedDialog } from "./Archived.js";
import { BackButton } from "../shell/BackButton.js";
import { PopMenu, StatusMenu, TaskMeta, TopicPicker, below, useGitBranch, type Anchor } from "./TaskHead.js";

/** Whether the right column (进度、批注、留言…) shows; off by default, remembered per window. */
const SIDEBAR_KEY = "amo.taskSidebar";
/** Whether the session list is hidden (会话 in the head; the key is from when it folded to a strip). */
const SESSIONS_KEY = "amo.sessionsFolded";
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // per-window convenience only
  }
}

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
  /** Opened right after the task was made: the session list starts folded (2026-10-15). */
  justCreated?: boolean;
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
export function TaskPage({ link, task, sessions, tasks = [task], workspaces, topics = [], profiles, checklist = [], initialSessionId, justCreated = false, backLabel = "看板", onBack }: TaskPageProps) {
  const own = sessions.filter((s) => s.taskId === task.id);
  // The first live session; in an archived task (or one whose sessions are all archived), the latest archived one.
  const firstSession = () => own.find((s) => !s.archivedAt) ?? [...own].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const [selected, setSelected] = useState<string | null>(initialSessionId ?? firstSession()?.id ?? null);
  // Notices float over the window (lib/toast); null clears nothing, they go away by themselves.
  const setToast = (t: Toast) => void (t && showToast(t));
  const [busy, setBusy] = useState(false);
  // The quick look of a file named in the conversation (stage 12); it takes the right column while open.
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  useEffect(() => {
    if (!selected || !own.some((s) => s.id === selected)) {
      const first = firstSession();
      if (first) setSelected(first.id);
    }
  }, [selected, own]);

  const session = own.find((s) => s.id === selected) ?? null;
  const settings = useSettings(link);
  const { items } = useSessionItems(link, session?.id ?? null);
  const annotations = useAnnotations(link, session?.id ?? null);
  // The model by name ("GPT-6.1 Sol", "Opus 5.5"), also when it is the profile's default.
  const { choices: sessionChoices } = useProfileChoices(link, session?.profileId);
  const modelText = session ? sessionModelName(sessionChoices, session.options) : null;
  const profile = (id: string) => profiles.find((p) => p.id === id);
  // Git Review: only for a project under git; the branch shows in the line under the title.
  const gitRepo = useIsGitRepo(link, task.workspaceId);
  const git = useGitBranch(link, task.workspaceId);
  const taskWorkspace = workspaces.find((w) => w.id === task.workspaceId);
  const taskTopic = topics.find((t) => t.id === task.topicId);
  const [statusAt, setStatusAt] = useState<Anchor | null>(null);
  const [picking, setPicking] = useState<"topic" | null>(null);
  const [taskMenu, setTaskMenu] = useState<Anchor | null>(null);
  const [sessionMenu, setSessionMenu] = useState<Anchor | null>(null);
  const [sidebar, setSidebarState] = useState(() => readFlag(SIDEBAR_KEY));
  const setSidebar = (on: boolean) => {
    setSidebarState(on);
    writeFlag(SIDEBAR_KEY, on);
  };
  // A task just made opens with its list hidden (it has one session: nothing to choose between); otherwise the list is
  // as the person last left it. The page is keyed by task, so this is read once per task opened.
  const [sessionsHidden, setSessionsHiddenState] = useState(() => justCreated || readFlag(SESSIONS_KEY));
  const setSessionsHidden = (on: boolean) => {
    setSessionsHiddenState(on);
    writeFlag(SESSIONS_KEY, on);
  };
  // The new-session form in the session list, opened from 新会话 in the head.
  const [creating, setCreating] = useState(false);

  /** A save from the annotation bubble: true once stored, else the error as a notice (the bubble keeps the draft). */
  async function annotationCall(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      setToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return false;
    }
  }

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
    topicId === task.topicId ? Promise.resolve() : run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { topicId }));
  const newTopic = (title: string) =>
    run(async () => {
      const topic = await call(link, "POST /api/topics", {}, { title });
      return call(link, "PATCH /api/tasks/:id", { id: task.id }, { topicId: topic.id });
    });
  // Archiving the whole task says so in a box of its own (stage 14), with the way back to where the task was opened
  // from; restoring it is a plain notice.
  const [archivedBox, setArchivedBox] = useState<{ sessions: number } | null>(null);
  const archiveTask = () => {
    const liveSessions = own.filter((s) => !s.archivedAt).length;
    return run(() => call(link, "POST /api/tasks/:id/archive", { id: task.id }), () => setArchivedBox({ sessions: liveSessions }));
  };
  const unarchiveTask = () => run(() => call(link, "POST /api/tasks/:id/unarchive", { id: task.id }), () => setToast({ text: "任务已恢复。" }));
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
  // A branch makes something to choose between: the list shows for this task (the remembered choice stays).
  const fork = (id: string) =>
    run(() => call(link, "POST /api/sessions/:id/fork", { id }, {}), (s) => {
      setSelected(s.id);
      setSessionsHiddenState(false);
    });
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
  // What waits in the hidden right column: shown as a count on 侧栏.
  const sideCount =
    decisions.filter((d) => d.taskId === task.id).length + mail.filter((m) => m.state === "unread").length + annotations.filter((a) => !a.sentAt).length;
  // Shown on 会话 while the list is hidden, when there is more than the one in front to choose from.
  const liveCount = own.filter((s) => !s.archivedAt).length;

  /** Scrolls to the annotated text of a reply and flashes it (its block, where highlights are not available). */
  function locate(a: Annotation, retry = true) {
    const reply = document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(a.itemId)}"]`);
    if (reply && flashAnnotation(a.id)) return;
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
      <div className="page-head task-head">
        <BackButton label={backLabel} onClick={onBack} />
        <div className="task-head-main">
          <h1 className="task-title" data-testid="task-title">
            <EditableName
              value={task.title}
              placeholder="未命名任务"
              label="任务名"
              disabled={!!task.archivedAt}
              onSave={(title) => void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { title }))}
            />
          </h1>
          <TaskMeta
            task={task}
            workspace={taskWorkspace}
            topic={taskTopic}
            branch={git.repo ? git.branch : null}
            disabled={!!task.archivedAt || busy}
            onStatus={setStatusAt}
            onTopic={() => setPicking("topic")}
          />
        </div>
        <div className="task-head-actions">
          {!task.archivedAt && (
            <button
              type="button"
              className="btn-ghost small with-icon"
              aria-expanded={creating}
              title="在这个任务里开一个新会话"
              onClick={() => {
                setCreating(!creating);
                if (!creating) setSessionsHidden(false);
              }}
              data-testid="new-session-toggle"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
                <path d="M8 5.2v3.6M6.2 7h3.6" />
              </svg>
              新会话
            </button>
          )}
          {gitRepo && (
            <button
              type="button"
              className="btn-ghost small with-icon"
              title="Git Review：查看项目的改动并逐行批注，批注发回当前会话"
              onClick={() => {
                const target = session && !session.archivedAt ? session : latestMainSession(sessions, task.id);
                openReview({ workspaceId: task.workspaceId, ...(target ? { sessionId: target.id } : {}) });
              }}
              data-testid="task-review"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 2.5h7l3 3v8H3z" />
                <path d="M6 7.5h4M8 5.5v4M6 11.5h4" />
              </svg>
              Review
            </button>
          )}
          <button type="button" className="btn-ghost small with-icon" title="文件标记：这个项目标记的文件（Ctrl+Shift+M）" onClick={() => openMarks({ workspaceId: task.workspaceId })} data-testid="task-marks">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 2.5h7v11l-3.5-2.6-3.5 2.6z" />
            </svg>
            标记
          </button>
          <button type="button" className="btn-ghost small icon-only" aria-label="任务的更多操作" title="更多" onClick={(e) => setTaskMenu(below(e.currentTarget))} data-testid="task-more">
            ⋯
          </button>
          <span className="head-sep" aria-hidden="true" />
          <button
            type="button"
            className="btn-ghost small sidebar-toggle"
            aria-pressed={!sessionsHidden}
            title={sessionsHidden ? "显示会话列表" : "隐藏会话列表"}
            onClick={() => setSessionsHidden(!sessionsHidden)}
            data-testid="sessions-toggle"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="1" />
              <path d="M6 2.5v11" />
            </svg>
            会话
            {sessionsHidden && liveCount > 1 && <span className="sidebar-count">{liveCount}</span>}
          </button>
          <button
            type="button"
            className="btn-ghost small sidebar-toggle"
            aria-pressed={sidebar}
            title={sidebar ? "收起侧栏" : "显示侧栏：进度、批注、留言、清单"}
            onClick={() => setSidebar(!sidebar)}
            data-testid="sidebar-toggle"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="1" />
              <path d="M10 2.5v11" />
            </svg>
            侧栏
            {!sidebar && sideCount > 0 && <span className="sidebar-count">{sideCount}</span>}
          </button>
        </div>
      </div>
      {statusAt && <StatusMenu at={statusAt} value={task.column} onPick={(c) => void setColumn(c)} onClose={() => setStatusAt(null)} />}
      {picking === "topic" && (
        <TopicPicker topics={topics} tasks={tasks} current={task.topicId} onPick={(id) => void setTopic(id)} onCreate={(title) => void newTopic(title)} onClose={() => setPicking(null)} />
      )}
      {taskMenu && (
        <PopMenu at={taskMenu} label="任务" onClose={() => setTaskMenu(null)} testId="task-menu">
          {task.topicId && (
            <div className="menu-check">
              <OnCanvasToggle key={task.topicId} link={link} taskId={task.id} topicId={task.topicId} disabled={!!task.archivedAt} onError={(text) => setToast({ text, error: true })} />
            </div>
          )}
          {!task.archivedAt && (
            <button
              type="button"
              role="menuitem"
              className="menu-danger"
              disabled={busy}
              onClick={() => {
                setTaskMenu(null);
                void archiveTask();
              }}
              data-testid="task-archive"
            >
              归档任务…
            </button>
          )}
          {task.archivedAt && <span className="menu-note">任务已归档</span>}
        </PopMenu>
      )}

      {task.archivedAt && (
        <div className="archived-banner task" role="status" data-testid="task-archived-banner">
          <ArchiveIcon />
          <span className="archived-banner-text">
            <b>已归档 · 只读</b>
            <span>
              {formatDay(task.archivedAt)} 归档。任务和它的会话只能查看，恢复任务后才能继续。
            </span>
          </span>
          <button type="button" className="btn-primary small" disabled={busy} onClick={() => void unarchiveTask()} data-testid="task-unarchive">
            恢复任务
          </button>
        </div>
      )}

      <div className="task-body">
        {!sessionsHidden && (
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
            creating={creating}
            onCreating={setCreating}
          />
        )}
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
              <span className="thread-model" data-testid="thread-model">
                {[shortModel(profile(session.profileId)), modelText].filter(Boolean).join(" · ")}
              </span>
              {/* 仅工作台 is the usual case and says nothing; the other writers matter. */}
              {writer && !session.archivedAt && session.writer !== "workbench" && (
                <span className="writer" style={{ color: writer.color }} data-testid="writer">
                  {writer.label}
                </span>
              )}
              <span className="spacer" />
              {/* Where the session works, opened outside Studio: editor, folder, terminal. */}
              <span className="bar-group" role="group" aria-label="在外部打开">
                {workdir && <WorkdirActions link={link} path={workdir} onError={showError} compact />}
                {!session.archivedAt && session.writer !== "terminal-handoff" && !(session.runtime === "claude" && session.kind === "sub") && (
                  <button
                    type="button"
                    className="bar-btn"
                    aria-label="在终端打开"
                    title={session.runtime === "claude" ? "在终端打开：交给终端里的 Claude 继续，工作台暂时只读" : "在终端打开：终端接入同一会话，两边都能输入"}
                    disabled={busy || !session.runtimeRef || (session.runtime === "claude" && session.status === "running")}
                    onClick={() => void openTerminal(session)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                      <path d="m4.2 6.2 2.3 1.8-2.3 1.8M8.3 10.2h3.2" />
                    </svg>
                  </button>
                )}
              </span>
              {!session.archivedAt && !(session.runtime === "claude" && session.kind === "sub") && (
                <>
                  <span className="head-sep" aria-hidden="true" />
                  <button type="button" className="bar-btn labeled" aria-label="分支" title="分支：从这里分出一个新会话，原会话不受影响" disabled={busy || !session.runtimeRef} onClick={() => void fork(session.id)} data-testid="session-fork">
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
                        void archive(session.id);
                      }}
                      data-testid="session-archive"
                    >
                      归档会话
                    </button>
                  )}
                </PopMenu>
              )}
            </div>
          )}
          {session?.archivedAt && !task.archivedAt && (
            <div className="archived-banner" role="status" data-testid="session-archived-banner">
              <ArchiveIcon />
              <span className="archived-banner-text">
                <b>已归档 · 只读</b>
                <span>{formatDay(session.archivedAt)} 归档。这个会话只能查看，恢复后才能继续。</span>
              </span>
              <button type="button" className="btn-primary small" disabled={busy} onClick={() => void restore(session.id)} data-testid="session-unarchive">
                恢复会话
              </button>
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
              model={modelText ?? shortModel(session ? profile(session.profileId) : undefined)}
              busy={busy}
              onApprove={(item, decision) => void approve(item.approvalId, decision)}
              onJump={setSelected}
              onSend={send}
              onInterrupt={() => session && void interrupt(session.id)}
              onSaveAnnotation={(anchor, note) => annotationCall(() => call(link, "POST /api/sessions/:id/annotations", { id: session!.id }, { ...anchor, note }))}
              onEditAnnotation={(id, note) => annotationCall(() => call(link, "PATCH /api/annotations/:id", { id }, { note }))}
              onDeleteAnnotation={(id) => void run(() => call(link, "DELETE /api/annotations/:id", { id }))}
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
            endLine={preview.endLine}
            column={preview.column}
            diff={preview.diff}
            onClose={() => setPreview(null)}
            extraActions={<MarkButton link={link} file={preview.file} line={preview.line} className="btn-ghost small" />}
          />
        )}
        {sidebar && (
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
          annotations={annotations}
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
        />
        )}
      </div>
      {archivedBox && (
        <TaskArchivedDialog
          title={task.title || "未命名任务"}
          sessions={archivedBox.sessions}
          backLabel={backLabel}
          onBack={() => {
            setArchivedBox(null);
            onBack();
          }}
          onClose={() => setArchivedBox(null)}
        />
      )}
    </section>
  );
}
