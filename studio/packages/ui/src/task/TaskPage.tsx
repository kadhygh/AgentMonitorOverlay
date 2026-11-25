import { useEffect, useRef, useState } from "react";
import { REMOTE_KINDS, REMOTE_ORDER_SINCE, REMOTE_TRACKS_SINCE, isCommon, remoteHeldTasks, taskLeadIn, taskRefText, type Annotation, type ChecklistItem, type ModelProfile, type NewSessionInput, type Session, type SessionOptions, type Task, type TaskColumn, type TodoView, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink, type Passage } from "../host/client.js";
import { rememberSession } from "../shell/lastPlace.js";
import { navHistory } from "../shell/navHistory.js";
import { shortModel } from "../lib/profiles.js";
import { StartingCover } from "../lib/StartingCover.js";
import { sessionModelName, useProfileChoices } from "../lib/choices.js";
import { SessionTree } from "./SessionTree.js";
import { forkOffOf, SessionThread, sessionRuntime, useSessionData } from "./SessionThread.js";
import { revealRow } from "./revealRow.js";
import { ForkDialog } from "./ForkDialog.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { flash } from "./ReplyNav.js";
import { annotationRange, flashAnnotation, flashRange, highlightsSupported, scrollToBox } from "../review/highlights.js";
import { REVEAL_ITEM_EVENT } from "../chat/Transcript.js";
import { useSettings } from "../settings/useSettings.js";
import { showToast } from "../lib/toast.js";
import { AnnotationPanel } from "../review/AnnotationPanel.js";
import { useLocalPending, useTaskMail } from "../collab/useInbox.js";
import { PendingPanel } from "../collab/PendingPage.js";
import { DecisionPanel, useOpenDecisions } from "../collab/DecisionPanel.js";
import { liveDecisions } from "../lib/decisions.js";
import { NotesPanel, useTaskNotes } from "../collab/NotesPanel.js";
import { ChecklistPanel } from "../collab/ChecklistPanel.js";
import { EditableName } from "./EditableName.js";
import { openReview, useIsGitRepo } from "../gitreview/open.js";
import { latestMainSession } from "../gitreview/logic.js";
import { OnCanvasToggle } from "../canvas/OnCanvasToggle.js";
import { openMarks } from "../marks/open.js";
import { MarkButton } from "../marks/MarkButton.js";
import type { PreviewTarget } from "../files/FileLinks.js";
import { FilePreview } from "../files/FilePreview.js";
import { ArchiveIcon, formatDay, TaskArchivedDialog } from "./Archived.js";
import { BackButton } from "../shell/BackButton.js";
import { PopMenu, StatusMenu, TaskMeta, TopicPicker, below, useGitBranch, type Anchor } from "./TaskHead.js";
import { SessionBanners, SessionHead } from "./SessionHead.js";
import { DescriptionDialog } from "./DescriptionDialog.js";
import { canBindTodo, loadTodoForBind, TodoBindDialog, type TodoBindTarget } from "./TodoBindDialog.js";
import { PlanBanner, useTaskPlans } from "../taskplans/TaskPlans.js";
import { RelayBanner, useRelays } from "../relays/Relays.js";
import { TeamRelayBanner, useTeamSends, useTeamThreads } from "../teamrelay/TeamRelay.js";
import { MattersPanel } from "../tracks/MattersPanel.js";
import { useWhiteboardMarks, WhiteboardView } from "../whiteboard/WhiteboardView.js";
import { CoworkBar, CoworkJoinDialog, useCoworkJoined } from "../teamrelay/Cowork.js";
import { TowerSwitch, TowerView, useTracksOn, type TowerPickTarget } from "../tracks/TowerView.js";
import { cardWindowOpen, composerInWindow, roundChatTarget, useRoundWindows } from "../tracks/rounds.js";
import { experimentalOn } from "../lib/features.js";
import type { ReadPlace } from "./readPlace.js";
import { copyStatus, grantsOf, useRemote } from "../remote/remote.js";
import { GrantDialog } from "./GrantDialog.js";
import { RemoteBanner } from "./RemoteBanner.js";
import { useStoredIds } from "../lib/storedIds.js";
import { ALSO_MINE_KEY, PINNED_KEY } from "../focus/pins.js";
import { readStored, writeStored } from "../lib/stored.js";
import { writeSessionDraft } from "./sessionDraft.js";
import { copySessionRef, copyTaskRef } from "../lib/copyRef.js";

/** Whether the right column (进度、批注、留言…) shows; off by default, remembered per window. */
const SIDEBAR_KEY = "amo.taskSidebar";
/** Whether the session list is hidden (会话 in the head; the key is from when it folded to a strip). */
const SESSIONS_KEY = "amo.sessionsFolded";
const readFlag = (key: string): boolean => readStored(key) === "1";
const writeFlag = (key: string, on: boolean): void => writeStored(key, on ? "1" : "0");

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
  /** 待我处理's 「全部 →」: the page across the workbench. */
  onOpenPending?(): void;
}

type Toast = { text: string; command?: string; error?: boolean } | null;

/** Task page: session tree | conversation with composer. Annotations and the scratchpad join in stage 2. */
export function TaskPage({ link, task, sessions, tasks = [task], workspaces, topics = [], profiles, checklist = [], initialSessionId, passage, restoreScroll, justCreated = false, backLabel = "看板", onBack, onOpenPending }: TaskPageProps) {
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
  const sessionData = useSessionData(link, session?.id ?? null);
  const { items, annotations, annotationRefs } = sessionData;
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
  // 「我也关心」 (2026-11-02, 问题 #8): this computer's Focus keeps listing the granted task as usual (focus/pins.ts), and
  // what agents open in the device's turns (查看包, Review) pops up here too (远程 Reviewer, the user 2026-11-02).
  const alsoMine = useStoredIds(ALSO_MINE_KEY);
  // 追踪 on the session bar (2026-11-03, 问题 #15): Focus's own 置顶 list, followed across windows.
  const focusPins = useStoredIds(PINNED_KEY);
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
  // 拉进协作 (2026-11-23): the session whose dialog is open.
  const [coworking, setCoworking] = useState<string | null>(null);
  /** 绑定到待办 (问题 #10): the 便签's 待办 to pick from, for the task or one of its sessions. */
  const [todoBind, setTodoBind] = useState<{ view: TodoView; target: TodoBindTarget } | null>(null);
  const bindTodo = (target: TodoBindTarget) => void loadTodoForBind().then((view) => view && setTodoBind({ view, target }));
  // 拆任务提案 this task (a 主控) made, while they wait for the person (also on its topic's canvas).
  const plans = useTaskPlans(link).filter((p) => p.fromTaskId === task.id);
  // 传话 to this task, or from it (a 主控), waiting for the person.
  const relays = useRelays(link).filter((r) => r.toTaskId === task.id || r.fromTaskId === task.id);
  // 会话里用中转 (2026-10-30): what its sessions ask to send through 中转, and whom they wait on there.
  const teamSends = useTeamSends(link);
  const teamThreads = useTeamThreads(link);
  const coworkJoined = useCoworkJoined(link);
  // 脉络的楼 (2026-11-15, behind 测试功能「脉络」): a 脉络会话 opens as its building; the switch above the conversation goes
  // to the other view for now (kept per session while the page is open). Not for a remote task's copy.
  // A copy (远程, 2026-11-15, the user: 我是远端操控好像看不到): its building comes from the computer it runs on (rt.tracks),
  // which an older Studio there does not answer — then the row says so instead of the switch.
  const tracksEnabled = experimentalOn(settings?.experimentalFeatures, "tracks");
  // 拖拽排序 (2026-11-17): a copy's list is put in order on its own computer, which an older Studio there cannot do.
  const orderOff = !copy ? null : copy.state === "revoked" ? "授权已收回：不能再调整会话的顺序" : !task.remote?.order ? `${copy.name} 上的 Studio 要更新到 ${REMOTE_ORDER_SINCE} 或更新的版本，才能在这台电脑上调整会话的顺序` : null;
  const tracksOff = copy && !task.remote?.kinds?.includes(REMOTE_KINDS.tracks) ? `${copy.name} 上的 Studio 要更新到 ${REMOTE_TRACKS_SINCE} 或更新的版本，才能在这台电脑上看这个会话的脉络` : undefined;
  const tracksOn = useTracksOn(link, tracksEnabled);
  const [towerPick, setTowerPick] = useState<Record<string, boolean>>({});
  // 白板 (2026-11-16, behind 测试功能「白板」, plans/whiteboard.md): the session's whiteboard in the conversation's place, picked
  // on the same row; it comes before the building while picked. Not for a remote task's copy yet.
  const boardEnabled = experimentalOn(settings?.experimentalFeatures, "whiteboard") && !copy;
  const boardMarks = useWhiteboardMarks(link, boardEnabled);
  const [boardPick, setBoardPick] = useState<Record<string, boolean>>({});
  const showBoard = !!session && boardEnabled && !!boardPick[session.id];
  const showTower = !!session && !showBoard && tracksEnabled && !tracksOff && (towerPick[session.id] ?? tracksOn.has(session.id));
  // 会话弹窗 (2026-11-16, the user: 点击某个卡片时，不要用侧边栏展示应该改成会话弹窗。弹窗开启时，下面的输入栏先隐藏，且输入栏的
  // 内容也展示到弹窗里。弹窗应该能拖动，能 pin。弹窗也能加批注。) — since 2026-11-16 a window of its own (the user: 脉络点击的弹窗
  // 要独立弹窗，不然会被限制拖动范围; app/src/round-window.ts): a card picked in the building opens the conversation of its
  // session (the building's, or one it started) there, at its row. The windows are the building's: the one not pinned
  // is what the building has picked (closing it lets the card go, letting the card go closes it), and all of them go
  // when the building does (对话 picked, 脉络会话 unticked, another session or page in front).
  const rounds = useRoundWindows();
  const towerId = showTower && session ? session.id : null;
  const cardOpen = !!towerId && cardWindowOpen(rounds, towerId);
  useEffect(() => {
    if (!towerId) return;
    return () => void window.amo?.round?.close({ towerFor: towerId, all: true });
  }, [towerId]);
  // While one shows the building's own session, the composer is there: here a line says so (and brings it forward).
  const composerAway = !!towerId && composerInWindow(rounds, towerId);
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
  // The 新会话 dialog (2026-11-17; before, a form in the session list), opened from 新会话 in the head.
  const [creating, setCreating] = useState(false);

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
  // A task filed with a first sentence (放进待办, 2026-11-05): the new session's composer starts with it, to be read
  // and sent (not sent by itself: the person may have picked a model or want to add to it), and the task lets it go.
  const newSession = (input: NewSessionInput) =>
    run(starts(input.profileId, () => call(link, "POST /api/tasks/:id/sessions", { id: task.id }, input)), (s) => {
      setCreating(false);
      // Something to choose between now: the list shows for this task (as after 分支).
      setSessionsHiddenState(false);
      const first = task.firstMessage;
      if (first && !copy) {
        writeSessionDraft(s.id, first);
        void call(link, "PATCH /api/tasks/:id", { id: task.id }, { firstMessage: "" }).catch(() => undefined);
      }
      setSelected(s.id);
    });
  const restore = (id: string) => run(() => call(link, "POST /api/sessions/:id/unarchive", { id }), () => setSelected(id));
  const archive = (id: string) =>
    run(() => call(link, "POST /api/sessions/:id/archive", { id }), () => {
      const next = own.find((s) => !s.archivedAt && s.id !== id && s.parentId !== id);
      setSelected(next?.id ?? null);
    });
  // 分支 (2026-11-10): the dialog asks from which turn and what the new session is; ⋯ opens it at the latest turn.
  const [forking, setForking] = useState<{ sessionId: string; turnId?: string } | null>(null);
  // 远程分支 (2026-11-12, the user: 远控模式下也能开分支): a copy's session is forked on the computer it runs on, as its
  // runtime there allows (an older one does not say it, nor fork: 分支 is greyed with what to update; SessionThread.tsx).
  const forkRuntime = sessionRuntime(task, session);
  const forkOff = forkOffOf(task, copy);
  // A branch makes something to choose between: the list shows for this task (the remembered choice stays).
  const forked = (s: Session) => {
    setForking(null);
    setSelected(s.id);
    setSessionsHiddenState(false);
  };
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
  const unread = new Map<string, number>();
  for (const m of mail) if (m.state === "unread" && m.to.kind === "session" && m.withdrawnAt === undefined && m.via !== "background") unread.set(m.to.sessionId, (unread.get(m.to.sessionId) ?? 0) + 1);
  // 待我处理 (2026-11-25, in place of 留言): what waits for the person about this task.
  const pending = useLocalPending(link, task.id);
  const pendingAsks = pending.asks.filter((m) => !m.relayId).length;

  const readOnly = !session || session.writer === "archived" || session.writer === "terminal-handoff";
  // What waits in the hidden right column: shown as a count on 侧栏.
  const sideCount =
    liveDecisions(decisions, sessions).filter((d) => d.taskId === task.id).length + pendingAsks + annotations.filter((a) => !a.sentAt).length;
  // Shown on 会话 while the list is hidden, when there is more than the one in front to choose from.
  const liveCount = own.filter((s) => !s.archivedAt).length;

  // Opened at a bookmarked passage (书签): once, when its reply has come in.
  const passageShown = useRef(false);
  useEffect(() => {
    if (!passage || passageShown.current || session?.id !== initialSessionId || !items.some((i) => i.id === passage.itemId)) return;
    passageShown.current = true;
    requestAnimationFrame(() => locatePassage(passage, 8));
  }, [passage, session?.id, items]);

  /** From the building: 「在对话里看这一轮」 (a row of this session) or 「打开子会话」 (another session, maybe a row of it). */
  function openFromTower(target: { sessionId?: string; itemId?: string }) {
    const host = session;
    const to = target.sessionId && target.sessionId !== host?.id ? target.sessionId : null;
    if (to) setSelected(to);
    else if (host) setTowerPick((cur) => ({ ...cur, [host.id]: false }));
    // The conversation is drawn (or the other session loaded) a moment later: look for the row then.
    if (target.itemId) window.setTimeout(() => revealRow(target.itemId!, 12), to ? 400 : 60);
  }

  /** A card of the building picked (tower.pick): its session's conversation in the 会话弹窗 window, at its row. */
  function pickFromTower(target: TowerPickTarget) {
    if (!towerId || !own.some((s) => s.id === target.sessionId)) return;
    void window.amo?.round?.open({ taskId: task.id, towerFor: towerId, ...target });
  }
  /** The building let its card go (its empty space, Esc in it): the window not pinned goes. */
  const unpickFromTower = () => towerId && void window.amo?.round?.close({ towerFor: towerId });
  // 到对话里看 in a window (it closes): that session as a plain conversation here, at the row read there.
  const toChat = useRef<(t: { sessionId: string; towerFor: string; itemId?: string }) => void>(() => undefined);
  toChat.current = (t) => {
    if (t.sessionId !== t.towerFor) setSelected(t.sessionId);
    else setTowerPick((cur) => ({ ...cur, [t.sessionId]: false }));
    if (t.itemId) window.setTimeout(() => revealRow(t.itemId!, 12), t.sessionId !== session?.id ? 400 : 60);
  };
  useEffect(
    () =>
      window.amo?.round?.onChat((v) => {
        const t = roundChatTarget(v);
        if (t && t.taskId === task.id) toChat.current(t);
      }),
    [task.id],
  );

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

  const head = session;
  const headWorkspace = head ? workspaces.find((w) => w.id === head.workspaceId) : undefined;
  const workdir = headWorkspace?.path;
  // The session's project (2026-11-09): a copy's as its own computer names it (its workspace here is the common folder).
  const sessionProject: string | null | undefined = !head ? undefined : task.remote ? (task.remote.sessionProjects?.[head.id] !== undefined ? task.remote.sessionProjects[head.id] : task.remote.project) : headWorkspace && !isCommon(headWorkspace) ? headWorkspace.name : null;
  const showError = (text: string) => setToast({ text, error: true });

  return (
    <section className="taskpage" aria-label="任务">
      <div className="page-head task-head">
        <BackButton label={backLabel} onClick={onBack} />
        <div className="task-head-main">
          <div className="task-title-row">
            <h1 className="task-title" data-testid="task-title">
              <EditableName
                value={task.title}
                placeholder="未命名任务"
                label="任务名"
                // A remote task is renamed on its own computer (2026-10-30), not while it is away or the grant is gone.
                disabled={!!task.archivedAt || (!!copy && (copy.state === "revoked" || !!copy.blocked))}
                onSave={(title) => void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { title }))}
              />
              {task.lead && (
                <span className="lead-badge" title="主控：协调这个专题（或项目）的任务。在 ⋯ 里可以取消" data-testid="task-lead">
                  主控
                </span>
              )}
            </h1>
            {/* 复制编号 (2026-11-23): beside the name, outside it (the name's text stays the name). */}
            <button type="button" className="btn-ghost small dim task-copy-ref" title={`复制「${taskRefText(task.title, task.id)}」，贴给 AI 或别人`} onClick={() => void copyTaskRef(task.title, task.id)} data-testid="task-copy-ref">
              复制编号
            </button>
          </div>
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
              aria-haspopup="dialog"
              title={copy ? `在这个任务里开一个新会话（在 ${copy.name} 上跑，只能选那边允许的模型）` : "在这个任务里开一个新会话"}
              onClick={() => setCreating(true)}
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
          {!copy && canBindTodo() && (
            <button
              type="button"
              role="menuitem"
              title="选一条便签里的待办绑定到这个任务：在待办里点它就回到这里"
              onClick={() => {
                setTaskMenu(null);
                bindTodo({ taskId: task.id, taskTitle: task.title });
              }}
              data-testid="task-bind-todo"
            >
              绑定到待办…
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
            // 按距离 (2026-11-25, the user 11-15: 默认自动，可配置): what the same topic's 主控 and tasks send comes in by itself
            // unless this says 先问 (relayAuto false); relayAuto true (the old 「主控传话不用确认」) also takes it from farther.
            <>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={task.relayAuto === false}
              disabled={busy}
              title="同一个专题的主控和别的任务给这个任务发的传话、留言，先放在「待我处理」里等你点「送进会话」；不勾时直接送进它的会话（等它这一轮做完）。别的专题、没有专题的一直先问你"
              onClick={() => {
                setTaskMenu(null);
                void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { relayAuto: task.relayAuto === false ? null : false }));
              }}
              data-testid="task-relay-ask"
            >
              {task.relayAuto === false ? "✓ " : ""}别的任务发来的先问我
            </button>
            {task.relayAuto === true && (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked
                disabled={busy}
                title="以前设的「主控传话不用确认」：连别的专题、没有专题的任务发来的也直接送进会话。点一下改回按距离：同专题直接送，更远的先问你"
                onClick={() => {
                  setTaskMenu(null);
                  void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { relayAuto: null }));
                }}
                data-testid="task-relay-auto"
              >
                ✓ 更远的任务发来的也直接送
              </button>
            )}
            </>
          )}
          {task.topicId && !copy && <OnCanvasToggle key={task.topicId} link={link} taskId={task.id} topicId={task.topicId} disabled={!!task.archivedAt} onError={(text) => setToast({ text, error: true })} />}
          {task.archivedAt && <span className="menu-note">任务已归档</span>}
        </PopMenu>
      )}
      {granting && <GrantDialog link={link} task={task} remote={remote} onClose={() => setGranting(false)} onDone={(text) => {
        setGranting(false);
        setToast({ text });
      }} />}

      {copy && <RemoteBanner task={task} copy={copy} sessions={own} profiles={profiles} usage={remote?.usage?.find((u) => u.account === task.remote?.account && u.device === task.remote?.device)} />}
      {granted.length > 0 && (
        <div className="remote-banner granted" role="status" data-testid="granted-banner">
          <span className="remote-badge">已授权</span>
          <span className="remote-banner-text">
            <span>
              {granted.map((g) => g.name).join("、")} 可以远程使用这个任务（会话还在这台电脑上跑）。{remoteHeld ? (alsoMine.has(task.id) ? "它在线，这台电脑的 Focus 也照常显示这个任务。" : "它在线，这个任务的提醒和进行中只在它那边的 Focus 出现。") : ""}
            </span>
          </span>
          <label className="granted-also-mine" title="勾上后，对方在线时这台电脑的 Focus 也照常显示这个任务的提醒、完成待审核和进行中；对方发消息引出的那一轮里，agent 打开的查看包和 Review 也在这台电脑上弹（只记在这台电脑上）" data-testid="granted-also-mine">
            <input type="checkbox" checked={alsoMine.has(task.id)} onChange={() => alsoMine.toggle(task.id)} />
            我也关心
          </label>
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
      {forking && own.some((s) => s.id === forking.sessionId) && (
        <ForkDialog
          link={link}
          session={own.find((s) => s.id === forking.sessionId)!}
          profile={profile(own.find((s) => s.id === forking.sessionId)!.profileId)}
          {...(forking.turnId ? { turnId: forking.turnId } : {})}
          {...(copy ? { remote: { name: copy.name, ...(forkRuntime ? { runtime: forkRuntime } : {}), mcp: !!task.remote?.mcp } } : {})}
          onClose={() => setForking(null)}
          onForked={forked}
        />
      )}
      {creating && !task.archivedAt && (
        <NewSessionDialog
          link={link}
          task={task}
          profiles={profiles}
          {...(copy ? { remote: { name: copy.name, allowed: task.remote!.allowed, blocked: copy.blocked, mcp: !!task.remote?.mcp, sessionTitle: !!task.remote?.sessionTitle } } : {})}
          busy={busy}
          onClose={() => setCreating(false)}
          onStart={(input) => void newSession(input)}
        />
      )}
      {describing && <DescriptionDialog link={link} task={task} onClose={() => setDescribing(false)} />}
      {coworking && own.some((s) => s.id === coworking) && (
        <CoworkJoinDialog
          link={link}
          session={own.find((s) => s.id === coworking)!}
          taskTitle={task.title}
          joined={coworkJoined}
          onClose={() => setCoworking(null)}
          onJoined={(j) => {
            setCoworking(null);
            setToast({ text: `已拉进协作「${j.coworkTitle}」，在里面叫「${j.name}」` });
          }}
        />
      )}
      {todoBind && <TodoBindDialog view={todoBind.view} target={todoBind.target} onClose={() => setTodoBind(null)} />}
      <PlanBanner link={link} plans={plans} tasks={tasks} workspaces={workspaces} profiles={profiles} />
      <RelayBanner link={link} relays={relays} tasks={tasks} />
      <TeamRelayBanner link={link} sends={teamSends} threads={teamThreads} sessions={own} />

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
            onNewSession={() => setCreating(true)}
            onReorder={(order) => call(link, "PUT /api/tasks/:id/session-order", { id: task.id }, { order })}
            reorderBlocked={orderOff}
            onRestore={(id) => void restore(id)}
            unread={unread}
          />
        )}
        <div className="thread-col">
          {head && (
            <SessionHead
              link={link}
              session={head}
              topicId={task.topicId}
              model={[shortModel(profile(head.profileId)), modelText].filter(Boolean).join(" · ")}
              {...(sessionProject !== undefined ? { project: sessionProject } : {})}
              workdir={workdir}
              busy={busy}
              {...(!task.archivedAt ? { tracked: focusPins.has(task.id), onTrack: () => focusPins.toggle(task.id) } : {})}
              onRename={(title) => void run(() => call(link, "PATCH /api/sessions/:id", { id: head.id }, { title }))}
              onTerminal={() => void openTerminal(head)}
              onFork={() => setForking({ sessionId: head.id })}
              {...(forkRuntime ? { forkRuntime } : {})}
              {...(forkOff || copy?.blocked ? { forkOff: forkOff ?? copy!.blocked! } : {})}
              onArchive={() => void archive(head.id)}
              onError={showError}
              {...(!copy && canBindTodo() ? { onBindTodo: () => bindTodo({ taskId: task.id, taskTitle: task.title, sessionId: head.id, sessionTitle: head.title }) } : {})}
              {...(!copy && !head.archivedAt && head.kind !== "sub" ? { onCowork: () => setCoworking(head.id) } : {})}
              {...(!copy ? { onCopyRef: () => void copySessionRef(link, head.id) } : {})}
              {...(!copy && head.kind === "main" && !head.archivedAt ? { taskLead: { is: taskLeadIn(task, sessions) === head.id, ...(!task.archivedAt ? { set: () => void run(() => call(link, "PATCH /api/tasks/:id", { id: task.id }, { leadSessionId: head.id })) } : {}) } } : {})}
            />
          )}
          {head && <SessionBanners session={head} taskArchived={!!task.archivedAt} busy={busy} onRestore={() => void restore(head.id)} onReclaim={() => void reclaim(head.id)} />}
          {head && !copy && <CoworkBar link={link} session={head} joined={coworkJoined} onError={showError} />}
          {head && (tracksEnabled || boardEnabled) && (
            <TowerSwitch
              {...(tracksOff ? { off: tracksOff } : {})}
              tracks={tracksEnabled}
              {...(boardEnabled
                ? {
                    board: {
                      shown: showBoard,
                      // Its AI wrote something the person has not looked at.
                      dot: !showBoard && (boardMarks.get(head.id)?.rev ?? 0) > (boardMarks.get(head.id)?.seenRev ?? 0),
                      onView: () => setBoardPick((cur) => ({ ...cur, [head.id]: true })),
                    },
                  }
                : {})}
              tower={showTower}
              on={tracksOn.has(head.id)}
              onView={(tower) => {
                // Back to the conversation: the windows go with the building (the effect on `towerId` above).
                setBoardPick((cur) => ({ ...cur, [head.id]: false }));
                setTowerPick((cur) => ({ ...cur, [head.id]: tower }));
              }}
              onToggle={(on) => void run(() => call(link, "PUT /api/sessions/:id/tracks", { id: head.id }, { on }), () => setTowerPick((cur) => ({ ...cur, [head.id]: on })))}
            />
          )}
          <SessionThread
            link={link}
            task={task}
            session={session}
            sessions={sessions}
            tasks={tasks}
            workspaces={workspaces}
            topics={topics}
            profiles={profiles}
            settings={settings}
            copy={copy}
            data={sessionData}
            decisions={decisions}
            busy={busy}
            run={run}
            onError={showError}
            onJump={setSelected}
            onForkTurn={(sessionId, turnId) => setForking({ sessionId, turnId })}
            onPreview={setPreview}
            {...(showBoard && session ? { cover: <WhiteboardView key={session.id} link={link} sessionId={session.id} /> } : {})}
            {...(showTower && session ? { cover: <TowerView key={session.id} link={link} sessionId={session.id} popup={cardOpen} onOpen={openFromTower} onPick={pickFromTower} onUnpick={unpickFromTower} /> } : {})}
            {...(composerAway && session ? { composerAway: { onShow: () => void window.amo?.round?.show(session.id) } } : {})}
            {...(restoreScroll !== undefined && session?.id === initialSessionId ? { initialScroll: restoreScroll } : {})}
            atPassage={!!passage && session?.id === initialSessionId}
          />
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
            {/* 事项清单 (2026-11-15; 设置 → 测试功能 → 脉络): the loops the session in front has going. */}
            {session && experimentalOn(settings?.experimentalFeatures, "tracks") && (
              <MattersPanel session={session} sessions={sessions} threads={teamThreads} items={items} decisions={decisions} onReveal={(itemId) => revealRow(itemId, 8)} onOpen={setSelected} />
            )}
            <DecisionPanel decisions={decisions} task={task} current={session?.id ?? null} sessionTitle={(id) => sessions.find((s) => s.id === id)?.title || "会话"} onOpen={setSelected} />
            <PendingPanel
              link={link}
              names={{ sessions, tasks, topics }}
              view={pending}
              current={session ?? null}
              onOpenAll={() => onOpenPending?.()}
            />
            <ChecklistPanel link={link} items={checklist} sessions={sessions} />
            <NotesPanel link={link} taskId={task.id} notes={notes} sessions={sessions} />
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
