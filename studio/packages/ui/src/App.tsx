import { useEffect, useState } from "react";
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
import { TopBar, useFocusToggle } from "./shell/TopBar.js";
import type { View, ViewContext, ViewDef } from "./shell/views.js";
import { VIEWS } from "./features.js";
import { featureOn, FeaturesProvider } from "./lib/features.js";
import { openMarks, useMarksShortcut } from "./marks/open.js";

// The shell: the Host connection, the scope and the view in front, the top bar and the left column. Pages come from
// the features (features.ts); the data several of them share is loaded here once.

/** Placeholder until the Host is connected (hooks run before the early return). */
const NO_LINK = { url: "", token: "" };

export function App() {
  const host = useHostState();
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [view, setView] = useState<View>({ kind: "board" });
  const focus = useFocusToggle();
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

  // 文件标记 (S12-D): the project in front — the task's, or the one the board is scoped to.
  const marksProject = (): string | null => {
    if (view.kind === "task" && host.kind === "ready") return host.state.tasks.find((t) => t.id === view.taskId)?.workspaceId ?? null;
    return scope.kind === "workspace" ? scope.id : null;
  };
  useMarksShortcut(marksProject);

  useEffect(
    () =>
      // From Focus: a task (and session), or the board when no task is named (scheduler proposals).
      window.amo?.onNavigate?.(({ taskId, sessionId }) =>
        setView(taskId ? { kind: "task", taskId, ...(sessionId ? { sessionId } : {}), nav: Date.now() } : { kind: "board" }),
      ),
    [],
  );

  if (host.kind !== "ready") {
    return (
      <div className="app">
        <TopBar views={VIEWS} view={view} scope={scope} onView={() => undefined} onNew={() => undefined} needs={0} scopeName="" focus={focus} disabled />
        <div className="placeholder" data-testid="host-status">
          {host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}
        </div>
      </div>
    );
  }

  const { state, link, live } = host;
  const disabled = settings?.disabledFeatures ?? [];
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

  return (
    <FeaturesProvider disabled={disabled}>
    <div className="app">
      <TopBar
        views={views}
        view={shown}
        scope={scope}
        onView={setView}
        onNew={() => setView({ kind: "new" })}
        onSettings={() => setSettingsOpen(true)}
        onMarks={() => {
          const ws = marksProject();
          openMarks(ws ? { workspaceId: ws } : {});
        }}
        needs={needs}
        scopeName={scopeName}
        focus={focus}
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
        />
        <main className="main">{def?.render(shown as never, ctx)}</main>
      </div>
      {settingsOpen && <SettingsDialog link={link} settings={settings} onClose={() => setSettingsOpen(false)} />}
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
            setView(session ? { kind: "task", taskId: task.id, sessionId: session.id } : { kind: "board" });
          }}
        />
      )}
    </div>
    </FeaturesProvider>
  );
}
