import { useState } from "react";
import type { Task } from "@amo-studio/protocol";
import { Board, type Scope } from "./board/Board.js";
import { ScopeNav } from "./board/ScopeNav.js";
import { useHostState } from "./host/useHostState.js";
import { needsPerson, taskSessions, taskStatus } from "./lib/status.js";
import "./styles/app.css";

type View = { kind: "board" } | { kind: "new" } | { kind: "task"; taskId: string };

export function App() {
  const host = useHostState();
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [view, setView] = useState<View>({ kind: "board" });

  if (host.kind !== "ready") {
    return (
      <div className="app">
        <TopBar onBoard={() => undefined} onNew={() => undefined} needs={0} scopeName="" disabled />
        <div className="placeholder" data-testid="host-status">
          {host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}
        </div>
      </div>
    );
  }

  const { state, link, live } = host;
  const needs = state.tasks.filter((t) => needsPerson(taskStatus(taskSessions(t, state.sessions)))).length;
  const scopeName = scope.kind === "area" ? "跨工作区" : scope.kind === "workspace" ? (state.workspaces.find((w) => w.id === scope.id)?.name ?? "") : "";
  const openTask = (task: Task) => setView({ kind: "task", taskId: task.id });

  return (
    <div className="app">
      <TopBar
        onBoard={() => setView({ kind: "board" })}
        onNew={() => setView({ kind: "new" })}
        needs={needs}
        scopeName={scopeName}
        boardActive={view.kind !== "new"}
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
          {view.kind === "board" && <Board tasks={state.tasks} sessions={state.sessions} workspaces={state.workspaces} scope={scope} onOpen={openTask} />}
          {view.kind === "new" && (
            <div className="placeholder">
              <span>新建任务页在 S1-10 实现。</span>
              <button type="button" className="btn-ghost" onClick={() => setView({ kind: "board" })}>
                ← 看板
              </button>
            </div>
          )}
          {view.kind === "task" && (
            <div className="placeholder">
              <span>任务页在 S1-11 实现：{state.tasks.find((t) => t.id === view.taskId)?.title}</span>
              <button type="button" className="btn-ghost" onClick={() => setView({ kind: "board" })}>
                ← 看板
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function TopBar({ onBoard, onNew, needs, scopeName, boardActive = true, disabled = false }: { onBoard(): void; onNew(): void; needs: number; scopeName: string; boardActive?: boolean; disabled?: boolean }) {
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
        <button type="button" className="view-tab" aria-current={boardActive ? "page" : undefined} onClick={onBoard} disabled={disabled}>
          看板
        </button>
        <button type="button" className="view-tab" disabled title="画布在阶段 3 实现">
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
      <button type="button" className="btn-primary" onClick={onNew} disabled={disabled}>
        + 新任务
      </button>
    </header>
  );
}
