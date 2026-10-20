import { useEffect, useState, useRef } from "react";
import type { Scope } from "./board/Board.js";
import { ScopeNav } from "./board/ScopeNav.js";
import { useHostState } from "./host/useHostState.js";
import { QuickStart } from "./newtask/QuickStart.js";
import { needsPerson, taskSessions, taskStatus } from "./lib/status.js";
import { useUnreadMail } from "./collab/useInbox.js";
import { useOpenDecisions } from "./collab/DecisionPanel.js";
import { useChecklist } from "./collab/ChecklistPanel.js";
import { usePendingProposals } from "./planning/ProposalsPanel.js";
import { useTodos } from "./planning/TodoTab.js";
import { SettingsDialog, useSettings } from "./settings/SettingsDialog.js";
import { setQuickModels } from "./lib/recents.js";
import { TopBar, useFocusToggle, usePinToggle, ViewBar } from "./shell/TopBar.js";
import { withOrigin, type View, type ViewContext, type ViewDef } from "./shell/views.js";
import { readPlace, savePlace } from "./shell/lastPlace.js";
import { SearchBox } from "./shell/SearchBox.js";
import type { SearchHit } from "./shell/search.js";
import { VIEWS } from "./features.js";
import { featureOn, FeaturesProvider } from "./lib/features.js";
import { openMarks, useMarksShortcut } from "./marks/open.js";
import { navHistory, useNavHistory } from "./shell/navHistory.js";
import type { MarksTarget } from "./marks/logic.js";
import { openReview } from "./gitreview/open.js";
import { onHostEvent } from "./host/events.js";
import { HostErrorToast, PaneBoundary } from "./lib/ErrorBoundary.js";
import { passageTrace } from "./lib/passageTrace.js";

// The shell: the Host connection, the scope and the view in front, the top bar and the left column. Pages come from
// the features (features.ts); the data several of them share is loaded here once.

/** Placeholder until the Host is connected (hooks run before the early return). */
const NO_LINK = { url: "", token: "" };

export function App() {
  const host = useHostState();
  // Where the workbench was left, again after a restart or reload (2026-10-15; shell/lastPlace).
  const [scope, setScope] = useState<Scope>(() => readPlace().scope);
  const [view, setShownView] = useState<View>(() => readPlace().view);
  useEffect(() => savePlace(view, scope), [view, scope]);
  // 后退 / 前进 (2026-10-19): every place shown is a step, except the one a step back or forward just restored.
  const restoring = useRef(false);
  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    navHistory.visit({ view, scope });
  }, [view, scope]);
  const nav = useNavHistory();
  const go = (dir: -1 | 1) => {
    const tasks = host.kind === "ready" ? host.state.tasks : [];
    const place = navHistory.step(dir, (p) => p.view.kind !== "task" || tasks.some((t) => t.id === (p.view as { taskId: string }).taskId));
    if (!place) return;
    restoring.current = true;
    setScope(place.scope);
    // A task page opens again (nav), on that session, read to where it was.
    setShownView(place.view.kind === "task" ? { ...place.view, nav: Date.now(), ...(place.scroll !== undefined ? { scroll: place.scroll } : {}) } : { ...place.view });
  };
  const goRef = useRef(go);
  goRef.current = go;
  // Alt+← / Alt+→, and the mouse's back and forward buttons, as in VS Code and a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      goRef.current(e.key === "ArrowLeft" ? -1 : 1);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      goRef.current(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);
  // A task or new-task page remembers where it was opened from (stage 14), whoever opens it: its "←" goes back there.
  const setView = (next: View) => setShownView((current) => withOrigin(next, current));
  const focus = useFocusToggle();
  const pin = usePinToggle();
  const unreadMail = useUnreadMail(host.kind === "ready" ? host.link : NO_LINK);
  const openDecisions = useOpenDecisions(host.kind === "ready" ? host.link : NO_LINK);
  const checklist = useChecklist(host.kind === "ready" ? host.link : NO_LINK);
  const proposals = usePendingProposals(host.kind === "ready" ? host.link : NO_LINK);
  const { todos } = useTodos(host.kind === "ready" ? host.link : NO_LINK);
  const settings = useSettings(host.kind === "ready" ? host.link : NO_LINK);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);

  // Ctrl N: the quick bar from anywhere; Ctrl Shift N: the draft task page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "n") return;
      e.preventDefault();
      if (e.shiftKey) {
        setQuickOpen(false);
        setView({ kind: "new" });
      } else setQuickOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 书签 (2026-10-19; 文件标记 before): the topic in front — the task's, or the one the board is scoped to — and its project.
  const marksTarget = (): MarksTarget => {
    if (view.kind === "task" && host.kind === "ready") {
      const task = host.state.tasks.find((t) => t.id === view.taskId);
      return task ? { topicId: task.topicId ?? "none", workspaceId: task.workspaceId } : {};
    }
    if (scope.kind === "topic") return { topicId: scope.id };
    return scope.kind === "workspace" ? { workspaceId: scope.id } : {};
  };
  useMarksShortcut(marksTarget);
  // 外部打开 Review (2026-10-18): another tool asked the Host (POST /api/review/open); this window opens the review window.
  // An event replayed after a reconnect is not a new request.
  useEffect(
    () =>
      onHostEvent((e) => {
        if (e.type !== "review.open" || Date.now() - Date.parse(e.at) > 60_000) return;
        openReview({ ...e.target, ...(e.target.file ? { nonce: `ext-${e.seq}` } : {}) });
      }),
    [],
  );

  useEffect(
    () =>
      // From Focus: a task (and session), or the board when no task is named (scheduler proposals).
      // From the bookmarks window too: a passage to scroll to and flash.
      window.amo?.onNavigate?.(({ taskId, sessionId, passage }) => {
        if (passage) passageTrace("workbench: navigate", { taskId, sessionId: sessionId ?? null, itemId: passage.itemId, hidden: document.hidden });
        setView(taskId ? { kind: "task", taskId, ...(sessionId ? { sessionId } : {}), ...(sessionId && passage ? { passage } : {}), nav: Date.now() } : { kind: "board" });
      }),
    [],
  );

  // A place come back to that is gone (a deleted task, an archived topic or project): the board, everything in scope.
  const ready = host.kind === "ready" ? host.state : null;
  useEffect(() => {
    if (!ready) return;
    if (view.kind === "task" && !ready.tasks.some((t) => t.id === view.taskId)) setShownView({ kind: "board" });
    const gone =
      (scope.kind === "topic" && !ready.topics.some((t) => t.id === scope.id && !t.archivedAt)) ||
      (scope.kind === "workspace" && !ready.workspaces.some((w) => w.id === scope.id && !w.archivedAt));
    if (gone) setScope({ kind: "all" });
  }, [ready, view, scope]);

  if (host.kind !== "ready") {
    return (
      <div className="app">
        <TopBar onView={() => undefined} needs={0} scopeName="" focus={focus} pin={pin} />
        <ViewBar views={VIEWS} view={view} scope={scope} onView={() => undefined} onNew={() => undefined} search={<SearchBox state={null} onOpen={() => undefined} disabled />} disabled />
        <div className="placeholder" data-testid="host-status">
          {host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}
        </div>
      </div>
    );
  }

  const { state, link, live } = host;
  const disabled = settings?.disabledFeatures ?? [];
  // 设置 → 模型 → 快速选择, for every model row of this window.
  setQuickModels(settings?.quickModels);
  const views = VIEWS.filter((d) => featureOn(disabled, d.feature));
  const planning = featureOn(disabled, "planning");
  const decisionsByTask = new Map<string, number>();
  for (const d of openDecisions) if (d.taskId) decisionsByTask.set(d.taskId, (decisionsByTask.get(d.taskId) ?? 0) + 1);
  // A task needs the person when a session waits for approval or review, or an agent asked for a decision.
  // Pending scheduler proposals wait for the person too (one each: they are not tasks yet).
  const needs =
    state.tasks.filter((t) => !t.archivedAt).filter((t) => needsPerson(taskStatus(taskSessions(t, state.sessions))) || decisionsByTask.has(t.id)).length +
    (planning ? proposals.length : 0);
  const scopeName =
    scope.kind === "topic" ? (state.topics.find((t) => t.id === scope.id)?.title ?? "") : scope.kind === "workspace" ? (state.workspaces.find((w) => w.id === scope.id)?.name ?? "") : "";
  const ctx: ViewContext = {
    link,
    state,
    scope,
    data: { unreadMail, openDecisions, decisionsByTask, checklist, proposals, todos },
    disabled,
    setView,
  };
  // A page of a feature that was just turned off falls back to the board.
  const shown: View = views.some((d) => d.kind === view.kind) ? view : { kind: "board" };
  const def = views.find((d) => d.kind === shown.kind) as ViewDef<typeof shown.kind> | undefined;
  // "+ 新任务" over a canvas works as the canvas's own: the task goes into that topic and "←" returns to the canvas.
  const liveTopics = state.topics.filter((t) => !t.archivedAt);
  const canvasTopic = shown.kind === "canvas" ? ((scope.kind === "topic" ? liveTopics.find((t) => t.id === scope.id) : undefined) ?? liveTopics[0]) : undefined;
  // 搜索: a task, a task's session, or a topic's own session (on that topic's canvas).
  const openHit = (hit: SearchHit) => {
    if (hit.kind === "task") setView({ kind: "task", taskId: hit.id, nav: Date.now() });
    else if (hit.taskId) setView({ kind: "task", taskId: hit.taskId, sessionId: hit.id, nav: Date.now() });
    else if (hit.topicId) {
      setScope({ kind: "topic", id: hit.topicId });
      setView({ kind: "canvas" });
    }
  };

  return (
    <FeaturesProvider disabled={disabled}>
    <div className="app">
      <TopBar
        onView={setView}
        needs={needs}
        scopeName={scopeName}
        focus={focus}
        pin={pin}
        onMarks={() => openMarks(marksTarget())}
        nav={{ ...nav, go }}
      />
      <div className="body">
        <ScopeNav
          link={link}
          workspaces={state.workspaces}
          topics={state.topics}
          tasks={state.tasks}
          scope={scope}
          live={live}
          onScope={(s) => {
            setScope(s);
            setView({ kind: "board" });
          }}
          onSettings={() => setSettingsOpen(true)}
        />
        <div className="main-col">
          <ViewBar
            views={views}
            view={shown}
            scope={scope}
            onView={setView}
            onNew={() => setView(canvasTopic ? { kind: "new", topicId: canvasTopic.id, back: { kind: "canvas" } } : { kind: "new" })}
            search={<SearchBox state={state} onOpen={openHit} />}
          />
          {/* A page that fails to render says so; the title bar, the left column and the sessions carry on. */}
          <main className="main">
            <PaneBoundary resetKey={JSON.stringify(shown)}>{def?.render(shown as never, ctx)}</PaneBoundary>
          </main>
        </div>
      </div>
      <HostErrorToast />
      {settingsOpen && <SettingsDialog link={link} settings={settings} workspaces={state.workspaces} onClose={() => setSettingsOpen(false)} />}
      {quickOpen && (
        <QuickStart
          link={link}
          workspaces={state.workspaces}
          topics={state.topics}
          profiles={state.profiles}
          onClose={() => setQuickOpen(false)}
          onExpand={() => {
            setQuickOpen(false);
            setView({ kind: "new" });
          }}
          onCreated={(task, session) => {
            setQuickOpen(false);
            // A task only filed leaves the person where they were.
            if (session) setView({ kind: "task", taskId: task.id, sessionId: session.id, created: true });
          }}
        />
      )}
    </div>
    </FeaturesProvider>
  );
}
