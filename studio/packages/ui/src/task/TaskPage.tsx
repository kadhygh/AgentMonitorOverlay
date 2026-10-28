import { useEffect, useRef, useState } from "react";
import { remoteHeldTasks, type Annotation, type ApprovalDecision, type ChecklistItem, type PresetDraft, type ModelProfile, type Session, type SessionOptions, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink, type Passage } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { useAnnotations } from "../review/useAnnotations.js";
import { useAnnotationRefs } from "../review/annotationRefs.js";
import { rememberSession } from "../shell/lastPlace.js";
import { navHistory } from "../shell/navHistory.js";
import { shortModel } from "../lib/profiles.js";
import { StartingCover } from "../lib/StartingCover.js";
import { sessionModelName, useProfileChoices } from "../lib/choices.js";
import { SessionTree } from "./SessionTree.js";
import { Thread } from "./Thread.js";
import { flash } from "./ReplyNav.js";
import { annotationRange, flashAnnotation, flashRange, highlightsSupported, scrollToBox } from "../review/highlights.js";
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
import { bookmarkPassage, openMarks } from "../marks/open.js";
import { BookmarkCancelled } from "../marks/NotePrompt.js";
import { MarkButton } from "../marks/MarkButton.js";
import { FileLinks, type PreviewTarget } from "../files/FileLinks.js";
import { FilePreview } from "../files/FilePreview.js";
import { ArchiveIcon, formatDay, TaskArchivedDialog } from "./Archived.js";
import { BackButton } from "../shell/BackButton.js";
import { PopMenu, StatusMenu, TaskMeta, TopicPicker, below, useGitBranch, type Anchor } from "./TaskHead.js";
import { SessionBanners, SessionHead } from "./SessionHead.js";
import { DescriptionDialog } from "./DescriptionDialog.js";
import { PlanBanner, useTaskPlans } from "../taskplans/TaskPlans.js";
import { RelayBanner, useRelays } from "../relays/Relays.js";
import type { ReadPlace } from "./readPlace.js";
import { copyStatus, grantsOf, REMOTE_FILES_LATER, useRemote } from "../settings/remote.js";
import { GrantDialog } from "./GrantDialog.js";

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
  /** Opened at a bookmarked passage of `initialSessionId` (书签): scrolled to and flashed once its reply is there. */
  passage?: Passage;
  /** 后退 back to this page: where `initialSessionId`'s conversation had been read. */
  restoreScroll?: ReadPlace;
  /** Opened right after the task was made: the session list starts folded (2026-10-15). */
  justCreated?: boolean;
  /** What "←" says: where it returns (看板 or 画布). */
  backLabel?: string;
  onBack(): void;
}

type Toast = { text: string; command?: string; error?: boolean } | null;

/** Task page: session tree | conversation with composer. Annotations and the scratchpad join in stage 2. */
export function TaskPage({ link, task, sessions, tasks = [task], workspaces, topics = [], profiles, checklist = [], initialSessionId, passage, restoreScroll, justCreated = false, backLabel = "看板", onBack }: TaskPageProps) {
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
  // The session looked at here, for coming back to this task after a restart (shell/lastPlace).
  useEffect(() => {
    if (session) rememberSession(task.id, session.id);
    // 后退 / 前进: another session of this task is another place.
    if (session) navHistory.pickSession(task.id, session.id);
  }, [task.id, session?.id]);
  const settings = useSettings(link);
  const { items } = useSessionItems(link, session?.id ?? null);
  const annotations = useAnnotations(link, session?.id ?? null);
  const annotationRefs = useAnnotationRefs(session?.id ?? null, annotations);
  // The model by name ("GPT-6.1 Sol", "Opus 5.5"), also when it is the profile's default.
  const { choices: sessionChoices } = useProfileChoices(link, session?.profileId);
  const modelText = session ? sessionModelName(sessionChoices, session.options) : null;
  const profile = (id: string) => profiles.find((p) => p.id === id);
  // 远程 (step 2, 2026-10-29): a copy of a task another computer granted this one (it runs there: no Git Review,
  // terminal, files or changes to the task here), or a task of this computer granted to other devices.
  const remote = useRemote(link);
  const copy = copyStatus(task, remote);
  const granted = grantsOf(remote, task.id);
  const remoteHeld = remoteHeldTasks(remote).has(task.id);
  const [granting, setGranting] = useState(false);
  // Git Review: only for a project under git; the branch shows in the line under the title.
  const gitRepo = useIsGitRepo(link, task.workspaceId) && !copy;
  const git = useGitBranch(link, task.workspaceId);
  const taskWorkspace = workspaces.find((w) => w.id === task.workspaceId);
  const taskTopic = topics.find((t) => t.id === task.topicId);
  const [statusAt, setStatusAt] = useState<Anchor | null>(null);
  const [picking, setPicking] = useState<"topic" | null>(null);
  const [taskMenu, setTaskMenu] = useState<Anchor | null>(null);
  const [describing, setDescribing] = useState(false);
  // 拆任务提案 this task (a 主控) made, while they wait for the person (also on its topic's canvas).
  const plans = useTaskPlans(link).filter((p) => p.fromTaskId === task.id);
  // 传话 to this task, or from it (a 主控), waiting for the person.
  const relays = useRelays(link).filter((r) => r.toTaskId === task.id || r.fromTaskId === task.id);
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
    // A copy of a remote task is deleted here, not kept as archived: back to where it was opened from.
    if (copy)
      return run(() => call(link, "POST /api/tasks/:id/archive", { id: task.id }), () => {
        setToast({ text: `已清掉这台电脑上的副本，任务在 ${copy.name} 上照常` });
        onBack();
      });
    const liveSessions = own.filter((s) => !s.archivedAt).length;
    return run(() => call(link, "POST /api/tasks/:id/archive", { id: task.id }), () => setArchivedBox({ sessions: liveSessions }));
  };
  const unarchiveTask = () => run(() => call(link, "POST /api/tasks/:id/unarchive", { id: task.id }), () => setToast({ text: "任务已恢复。" }));
  // 正在启动: the conversation column is covered while a new session starts (its process takes a few seconds).
  const [starting, setStarting] = useState<string | null>(null);
  const starts = <T,>(profileId: string, fn: () => Promise<T>) => async () => {
    setStarting(`正在启动 ${shortModel(profile(profileId))}…`);
    try {
      return await fn();
    } finally {
      setStarting(null);
    }
  };
  const newSession = (input: { profileId: string; options?: SessionOptions }) =>
    run(starts(input.profileId, () => call(link, "POST /api/tasks/:id/sessions", { id: task.id }, input)), (s) => setSelected(s.id));
  const openPreset = (key: string) => {
    const [workspaceId, pack, preset] = key.split("/") as [string, string, string];
    void run(() => call(link, "POST /api/workspaces/:id/packs/:pack/presets/:preset/draft", { id: workspaceId, pack, preset }, { taskId: task.id }), setDraft);
  };
  const startPreset = (d: PresetDraft, input: { profileId: string; text: string }) =>
    run(
      starts(input.profileId, () => call(link, "POST /api/tasks/:id/sessions", { id: task.id }, { profileId: input.profileId, text: input.text })),
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

  // Opened at a bookmarked passage (书签): once, when its reply has come in.
  const passageShown = useRef(false);
  useEffect(() => {
    if (!passage || passageShown.current || session?.id !== initialSessionId || !items.some((i) => i.id === passage.itemId)) return;
    passageShown.current = true;
    requestAnimationFrame(() => locatePassage(passage, 8));
  }, [passage, session?.id, items]);

  /** Scrolls to a bookmarked passage and flashes just its text (its block, where highlights are not available). */
  function locatePassage(p: Passage, tries: number) {
    const reply = document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(p.itemId)}"]`);
    if (!reply) {
      // In a folded turn: unfold it, then look again once it has rendered.
      if (tries <= 0) return;
      window.dispatchEvent(new CustomEvent(REVEAL_ITEM_EVENT, { detail: p.itemId }));
      requestAnimationFrame(() => requestAnimationFrame(() => locatePassage(p, tries - 1)));
      return;
    }
    const item = items.find((i) => i.id === p.itemId);
    const source = item?.type === "agent" ? item.markdown : null;
    const range = source !== null && highlightsSupported() ? annotationRange(reply, p, source) : null;
    if (range) return flashRange(range);
    const target = [...reply.querySelectorAll<HTMLElement>("[data-src-start]")].find((b) => Number(b.dataset.srcStart) < p.end && Number(b.dataset.srcEnd) > p.start) ?? reply;
    scrollToBox(target, () => target.getBoundingClientRect());
    flash(target);
  }

  const bookmark = (anchor: Parameters<typeof bookmarkPassage>[2]) => {
    if (!session) return;
    bookmarkPassage(link, session.id, anchor)
      .then((r) => {
        const where = topics.find((t) => t.id === r.mark.topicId)?.title ?? "未归专题";
        setToast({ text: r.created ? `书签添加成功：已加到「${where}」` : `这段已经在「${where}」的书签里` });
      })
      .catch((err: unknown) => {
        if (!(err instanceof BookmarkCancelled)) setToast({ text: `加书签失败：${err instanceof HostApiError ? err.message : String(err)}`, error: true });
      });
  };

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
    scrollToBox(target, () => target.getBoundingClientRect());
    flash(target);
  }

  const approve = (approvalId: string, decision: ApprovalDecision) =>
    session ? run(() => call(link, "POST /api/approvals/:approvalId", { approvalId }, { sessionId: session.id, decision })) : Promise.resolve();
  const interrupt = (id: string) => run(() => call(link, "POST /api/sessions/:id/interrupt", { id }));
  async function send(text: string, attachments: string[]): Promise<boolean> {
    if (!session) return false;
    try {
      const referred = annotationRefs.list.map((a) => a.id);
      await call(link, "POST /api/sessions/:id/messages", { id: session.id }, { text, ...(attachments.length ? { attachments } : {}), ...(referred.length ? { annotations: referred } : {}) });
      annotationRefs.sent();
      return true;
    } catch (err) {
      setToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return false;
    }
  }
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
              disabled={!!task.archivedAt || !!copy}
              onSave={(title) => void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { title }))}
            />
            {task.lead && (
              <span className="lead-badge" title="主控：协调这个专题（或项目）的任务。在 ⋯ 里可以取消" data-testid="task-lead">
                主控
              </span>
            )}
          </h1>
          <TaskMeta
            task={task}
            workspace={taskWorkspace}
            topic={taskTopic}
            branch={git.repo && !copy ? git.branch : null}
            disabled={!!task.archivedAt || busy || !!copy}
            onStatus={setStatusAt}
            onTopic={() => setPicking("topic")}
          />
        </div>
        <div className="task-head-actions">
          {!task.archivedAt && !(copy && copy.state === "revoked") && (
            <button
              type="button"
              className="btn-ghost small with-icon"
              aria-expanded={creating}
              title={copy ? `在这个任务里开一个新会话（在 ${copy.name} 上跑，只能选那边允许的模型）` : "在这个任务里开一个新会话"}
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
          {!copy && (
          <button type="button" className="btn-ghost small with-icon" title="书签：这个专题记下的文件和对话片段（Ctrl+Shift+M）" onClick={() => openMarks({ topicId: task.topicId ?? "none", workspaceId: task.workspaceId, taskId: task.id })} data-testid="task-marks">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 2.5h7v11l-3.5-2.6-3.5 2.6z" />
            </svg>
            书签
          </button>
          )}
          {/* 归档 on its own, left of ⋯ (2026-10-23). */}
          {!task.archivedAt && (
            <button type="button" className="btn-ghost small with-icon soft-danger" title={copy ? `归档：清掉这台电脑上的副本（任务在 ${copy.name} 上照常${copy.state === "revoked" ? "" : "；以后那边重新授权才会再出现"}）` : "归档任务：任务和它的会话变成只读，之后可以恢复"} disabled={busy} onClick={() => void archiveTask()} data-testid="task-archive">
              <ArchiveIcon size={15} />
              归档
            </button>
          )}
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
          {copy && <span className="menu-note">远程任务：名字、状态、说明在 {copy.name} 上改</span>}
          {!task.archivedAt && !copy && (
            <button
              type="button"
              role="menuitem"
              title="让你的另一台电脑远程使用这个任务：会话还在这台电脑上跑"
              onClick={() => {
                setTaskMenu(null);
                setGranting(true);
              }}
              data-testid="task-grant"
            >
              授权给…
            </button>
          )}
          {granted.map((g) => (
            <button
              key={`${g.account}\n${g.device}`}
              type="button"
              role="menuitem"
              disabled={busy}
              title="那边保留已经同步的记录（只读），不能再操作这个任务"
              onClick={() => {
                setTaskMenu(null);
                void run(() => call(link, "POST /api/remote/grants/revoke", {}, { taskId: task.id, account: g.account, device: g.device }), () => setToast({ text: `已收回 ${g.name} 的授权` }));
              }}
              data-testid="task-revoke"
            >
              收回 {g.name} 的授权
            </button>
          ))}
          {!task.archivedAt && !copy && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setTaskMenu(null);
                setDescribing(true);
              }}
              data-testid="task-describe"
            >
              {task.description ? "编辑说明…" : "添加说明…"}
            </button>
          )}
          {!task.archivedAt && !copy && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              title="主控负责协调它的专题（不在专题里时是它的项目）：拆任务、排画布、写专题文档"
              onClick={() => {
                setTaskMenu(null);
                void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { lead: !task.lead }));
              }}
              data-testid="task-lead-toggle"
            >
              {task.lead ? "取消主控" : "设为主控"}
            </button>
          )}
          {!task.archivedAt && !copy && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={!!task.relayAuto}
              disabled={busy}
              title="主控给这个任务的传话直接送进它的会话，不再等你确认（长任务里自动送话很正常）"
              onClick={() => {
                setTaskMenu(null);
                void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { relayAuto: !task.relayAuto }));
              }}
              data-testid="task-relay-auto"
            >
              {task.relayAuto ? "✓ " : ""}主控传话不用确认
            </button>
          )}
          {task.topicId && !copy && <OnCanvasToggle key={task.topicId} link={link} taskId={task.id} topicId={task.topicId} disabled={!!task.archivedAt} onError={(text) => setToast({ text, error: true })} />}
          {task.archivedAt && <span className="menu-note">任务已归档</span>}
        </PopMenu>
      )}
      {granting && <GrantDialog link={link} task={task} remote={remote} onClose={() => setGranting(false)} onDone={(text) => {
        setGranting(false);
        setToast({ text });
      }} />}

      {copy && (
        <div className={`remote-banner ${copy.state}`} role="status" data-testid="remote-banner" data-state={copy.state}>
          <span className="remote-badge">远程</span>
          <span className="remote-banner-text">
            {copy.state === "revoked" ? (
              <>
                <b>授权已收回</b>
                <span>
                  {task.remote!.reason && task.remote!.reason !== "授权已收回" ? `${task.remote!.reason}。` : `${copy.name} 收回了这个任务的授权。`}已经同步的记录还能看，不会再连回去。归档会清掉这台电脑上的副本。
                </span>
              </>
            ) : copy.state === "offline" ? (
              <>
                <b>{copy.label}</b>
                <span>记录能看；现在不能发消息、不能审批，写好的消息留在输入框里。{copy.self ? "这台电脑连上团队服务器后" : `${copy.name} 回来后`}会自动重连，补齐这段时间的记录。</span>
              </>
            ) : (
              <>
                <b>在 {copy.name} 上运行</b>
                <span>这是 {task.remote!.account} 的「{copy.name}」授权给这台电脑的任务：模型调用和命令都在那台电脑上。文件查看、Git Review、终端要在那边用。</span>
              </>
            )}
          </span>
        </div>
      )}
      {granted.length > 0 && (
        <div className="remote-banner granted" role="status" data-testid="granted-banner">
          <span className="remote-badge">已授权</span>
          <span className="remote-banner-text">
            <span>
              {granted.map((g) => g.name).join("、")} 可以远程使用这个任务（会话还在这台电脑上跑）。{remoteHeld ? "它在线，这个任务的提醒只在它那边出现。" : ""}
            </span>
          </span>
          {granted.map((g) => (
            <button key={`${g.account}\n${g.device}`} type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(() => call(link, "POST /api/remote/grants/revoke", {}, { taskId: task.id, account: g.account, device: g.device }), () => setToast({ text: `已收回 ${g.name} 的授权` }))} data-testid="granted-revoke">
              收回{granted.length > 1 ? ` ${g.name}` : ""}
            </button>
          ))}
        </div>
      )}

      {task.description && (
        <div className="task-desc" data-testid="task-description">
          <p className="task-desc-text">{task.description}</p>
          {!task.archivedAt && !copy && (
            <button type="button" className="link-btn" onClick={() => setDescribing(true)}>
              编辑
            </button>
          )}
        </div>
      )}
      {describing && <DescriptionDialog link={link} task={task} onClose={() => setDescribing(false)} />}
      <PlanBanner link={link} plans={plans} tasks={tasks} workspaces={workspaces} profiles={profiles} />
      <RelayBanner link={link} relays={relays} tasks={tasks} />

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
            {...(copy ? { remote: { name: copy.name, allowed: task.remote!.allowed, blocked: copy.blocked } } : {})}
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
            <SessionHead
              link={link}
              session={session}
              topicId={task.topicId}
              model={[shortModel(profile(session.profileId)), modelText].filter(Boolean).join(" · ")}
              workdir={workdir}
              busy={busy}
              onRename={(title) => void run(() => call(link, "PATCH /api/sessions/:id", { id: session.id }, { title }))}
              onTerminal={() => void openTerminal(session)}
              onFork={() => void fork(session.id)}
              onArchive={() => void archive(session.id)}
              onError={showError}
            />
          )}
          {session && <SessionBanners session={session} taskArchived={!!task.archivedAt} busy={busy} onRestore={() => void restore(session.id)} onReclaim={() => void reclaim(session.id)} />}
          <FileLinks link={link} workspaceId={session?.workspaceId ?? task.workspaceId} sessionId={session?.id ?? null} onPreview={setPreview} onError={showError} {...(copy ? { remoteNote: REMOTE_FILES_LATER } : {})}>
            <Thread
              link={link}
              {...(copy ? { remote: { blocked: copy.blocked, revoked: copy.state === "revoked" } } : {})}
              presets={settings?.presets ?? []}
              session={session}
              {...(session && profile(session.profileId) ? { profile: profile(session.profileId)! } : {})}
              profiles={profiles}
              subsessionNotes={settings?.subsessionNotes ?? []}
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
              onBookmark={bookmark}
              {...(restoreScroll !== undefined && session?.id === initialSessionId ? { initialScroll: restoreScroll } : {})}
              atPassage={!!passage && session?.id === initialSessionId}
              onError={showError}
              annotations={annotations}
              annotationRefs={annotationRefs}
              decisions={session ? decisions.filter((d) => d.sessionId === session.id) : []}
            />
          </FileLinks>
          {starting && <StartingCover label={starting} />}
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
            extraActions={<MarkButton link={link} file={preview.file} line={preview.line} sessionId={session?.id ?? null} className="btn-ghost small" />}
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
          onPin={(id, pinned) => void run(() => call(link, "PATCH /api/annotations/:id", { id }, { pinned }))}
          onLocate={locate}
          refs={annotationRefs}
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
