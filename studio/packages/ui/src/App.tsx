import { useEffect, useState } from "react";
import { workspacesActivity, type Task } from "@amo-studio/protocol";
import { Board, type Scope } from "./board/Board.js";
import { ScopeNav } from "./board/ScopeNav.js";
import { useHostState } from "./host/useHostState.js";
import { NewTaskPage } from "./newtask/NewTaskPage.js";
import { TaskPage } from "./task/TaskPage.js";
import { PacksPage } from "./packs/PacksPage.js";
import { CanvasPage } from "./canvas/CanvasPage.js";
import { needsPerson, taskSessions, taskStatus } from "./lib/status.js";
import { mailByTask, useUnreadMail } from "./host/useInbox.js";
import { useOpenDecisions } from "./task/DecisionPanel.js";
import { checklistByTask, useChecklist } from "./task/ChecklistPanel.js";
import { ProposalsPanel, usePendingProposals } from "./board/ProposalsPanel.js";
import { useTodos } from "./canvas/TodoTab.js";

// `nav` changes when Focus asks for a session, so an already open task page re-opens on that session.
type View = { kind: "board" } | { kind: "canvas" } | { kind: "new" } | { kind: "packs"; workspaceId: string } | { kind: "task"; taskId: string; sessionId?: string; nav?: number };

/** Focus window on/off, mirrored from the Electron shell (absent in a plain browser). */
function useFocusToggle(): { on: boolean; available: boolean; set(on: boolean): void } {
  const api = window.amo?.focus;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!api) return;
    void api.get().then(setOn);
    return api.onChange(setOn);
  }, [api]);
  return { on, available: !!api, set: (next) => void api?.set(next) };
}

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
        <TopBar onBoard={() => undefined} onCanvas={() => undefined} onNew={() => undefined} needs={0} scopeName="" focus={focus} disabled />
        <div className="placeholder" data-testid="host-status">
          {host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}
        </div>
      </div>
    );
  }

  const { state, link, live } = host;
  const decisionsByTask = new Map<string, number>();
  for (const d of openDecisions) decisionsByTask.set(d.taskId, (decisionsByTask.get(d.taskId) ?? 0) + 1);
  // A task needs the person when a session waits for approval or review, or an agent asked for a decision.
  // Pending scheduler proposals wait for the person too (one each: they are not tasks yet).
  const needs = state.tasks.filter((t) => needsPerson(taskStatus(taskSessions(t, state.sessions))) || decisionsByTask.has(t.id)).length + proposals.length;
  const scopeName = scope.kind === "area" ? "跨工作区" : scope.kind === "workspace" ? (state.workspaces.find((w) => w.id === scope.id)?.name ?? "") : "";
  const openTask = (task: Task) => setView({ kind: "task", taskId: task.id });

  return (
    <div className="app">
      <TopBar
        onBoard={() => setView({ kind: "board" })}
        onCanvas={() => setView({ kind: "canvas" })}
        onNew={() => setView({ kind: "new" })}
        {...(scope.kind === "workspace" ? { onPacks: () => setView({ kind: "packs", workspaceId: scope.id }) } : {})}
        needs={needs}
        scopeName={scopeName}
        focus={focus}
        active={view.kind === "canvas" ? "canvas" : view.kind === "packs" ? "packs" : view.kind === "new" ? null : "board"}
      />
      <div className="body">
        <ScopeNav
          link={link}
          workspaces={state.workspaces}
          tasks={state.tasks}
          scope={scope}
          live={live}
          onScope={(s) => {
            setScope(s);
            setView({ kind: "board" });
          }}
        />
        <main className="main">
          {view.kind === "board" && (
            <ProposalsPanel
              link={link}
              proposals={proposals}
              todos={todos}
              workspaces={state.workspaces}
              profiles={state.profiles}
              activity={workspacesActivity(state.workspaces, state.sessions)}
              onStarted={(taskId, sessionId) => setView({ kind: "task", taskId, sessionId })}
            />
          )}
          {view.kind === "board" && (
            <Board
              tasks={state.tasks}
              sessions={state.sessions}
              workspaces={state.workspaces}
              scope={scope}
              onOpen={openTask}
              mail={mailByTask(unreadMail, state.sessions)}
              decisions={decisionsByTask}
              checklist={checklistByTask(checklist)}
            />
          )}
          {view.kind === "canvas" && (
            <CanvasPage
              link={link}
              tasks={state.tasks}
              sessions={state.sessions}
              workspaces={state.workspaces}
              profiles={state.profiles}
              onOpenTask={(taskId) => setView({ kind: "task", taskId })}
            />
          )}
          {view.kind === "packs" && (() => {
            const ws = state.workspaces.find((w) => w.id === view.workspaceId);
            return ws ? <PacksPage key={ws.id} link={link} workspace={ws} profiles={state.profiles} /> : <div className="placeholder">工作区不存在或已被移除。</div>;
          })()}
          {view.kind === "new" && (
            <NewTaskPage
              link={link}
              workspaces={state.workspaces}
              profiles={state.profiles}
              scope={scope}
              onBack={() => setView({ kind: "board" })}
              onCreated={(task, session) => setView({ kind: "task", taskId: task.id, sessionId: session.id })}
            />
          )}
          {view.kind === "task" && (() => {
            const task = state.tasks.find((t) => t.id === view.taskId);
            if (!task) return <div className="placeholder">任务不存在或已被删除。</div>;
            return (
              <TaskPage
                key={`${task.id}:${view.nav ?? 0}`}
                link={link}
                task={task}
                sessions={state.sessions}
                tasks={state.tasks}
                workspaces={state.workspaces}
                profiles={state.profiles}
                checklist={checklist.filter((i) => i.taskId === task.id)}
                {...(view.sessionId ? { initialSessionId: view.sessionId } : {})}
                onBack={() => setView({ kind: "board" })}
              />
            );
          })()}
        </main>
      </div>
    </div>
  );
}

function TopBar({
  onBoard,
  onCanvas,
  onPacks,
  onNew,
  needs,
  scopeName,
  focus,
  active = "board",
  disabled = false,
}: {
  focus: { on: boolean; available: boolean; set(on: boolean): void };
  onBoard(): void;
  onCanvas(): void;
  /** Only when one workspace is in scope: its extension packs. */
  onPacks?: () => void;
  onNew(): void;
  needs: number;
  scopeName: string;
  active?: "board" | "canvas" | "packs" | null;
  disabled?: boolean;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">A</div>
        <span className="brand-name">AMO Studio</span>
        {scopeName && (
          <>
            <span className="brand-sep">/</span>
            <span style={{ fontWeight: 500 }}>{scopeName}</span>
          </>
        )}
      </div>
      <nav className="view-tabs" aria-label="视图">
        <button type="button" className="view-tab" aria-current={active === "board" ? "page" : undefined} onClick={onBoard} disabled={disabled}>
          看板
        </button>
        <button type="button" className="view-tab" aria-current={active === "canvas" ? "page" : undefined} onClick={onCanvas} disabled={disabled}>
          画布
        </button>
        {onPacks && (
          <button type="button" className="view-tab" aria-current={active === "packs" ? "page" : undefined} onClick={onPacks} disabled={disabled}>
            扩展包
          </button>
        )}
      </nav>
      <div className="spacer" />
      {needs > 0 && (
        <button type="button" className="needs" onClick={onBoard} data-testid="needs-you">
          <span className="dot" style={{ background: "var(--attention)", width: 7, height: 7 }} />
          需要你 {needs}
        </button>
      )}
      {focus.available && (
        <button
          type="button"
          className="btn-ghost small"
          aria-pressed={focus.on}
          title="桌面角落的悬浮窗：只列需要你处理的会话"
          onClick={() => focus.set(!focus.on)}
        >
          Focus {focus.on ? "开" : "关"}
        </button>
      )}
      <button type="button" className="btn-primary" onClick={onNew} disabled={disabled}>
        + 新任务
      </button>
    </header>
  );
}
