import { useEffect, useState } from "react";
import type { Task } from "@amo-studio/protocol";
import { Board, type Scope } from "./board/Board.js";
import { ScopeNav } from "./board/ScopeNav.js";
import { useHostState } from "./host/useHostState.js";
import { NewTaskPage } from "./newtask/NewTaskPage.js";
import { TaskPage } from "./task/TaskPage.js";
import { CanvasPage } from "./canvas/CanvasPage.js";
import { needsPerson, taskSessions, taskStatus } from "./lib/status.js";
import { mailByTask, useUnreadMail } from "./host/useInbox.js";
import { useOpenDecisions } from "./task/DecisionPanel.js";

// `nav` changes when Focus asks for a session, so an already open task page re-opens on that session.
type View = { kind: "board" } | { kind: "canvas" } | { kind: "new" } | { kind: "task"; taskId: string; sessionId?: string; nav?: number };

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

  useEffect(
    () =>
      window.amo?.onNavigate?.(({ taskId, sessionId }) =>
        setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), nav: Date.now() }),
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
  const needs = state.tasks.filter((t) => needsPerson(taskStatus(taskSessions(t, state.sessions))) || decisionsByTask.has(t.id)).length;
  const scopeName = scope.kind === "area" ? "跨工作区" : scope.kind === "workspace" ? (state.workspaces.find((w) => w.id === scope.id)?.name ?? "") : "";
  const openTask = (task: Task) => setView({ kind: "task", taskId: task.id });

  return (
    <div className="app">
      <TopBar
        onBoard={() => setView({ kind: "board" })}
        onCanvas={() => setView({ kind: "canvas" })}
        onNew={() => setView({ kind: "new" })}
        needs={needs}
        scopeName={scopeName}
        focus={focus}
        active={view.kind === "canvas" ? "canvas" : view.kind === "new" ? null : "board"}
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
            <Board
              tasks={state.tasks}
              sessions={state.sessions}
              workspaces={state.workspaces}
              scope={scope}
              onOpen={openTask}
              mail={mailByTask(unreadMail, state.sessions)}
              decisions={decisionsByTask}
            />
          )}
          {view.kind === "canvas" && (
            <CanvasPage
              link={link}
              tasks={state.tasks}
              sessions={state.sessions}
              workspaces={state.workspaces}
              onOpenTask={(taskId) => setView({ kind: "task", taskId })}
            />
          )}
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
  onNew(): void;
  needs: number;
  scopeName: string;
  active?: "board" | "canvas" | null;
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
