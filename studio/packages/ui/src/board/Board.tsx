import { TASK_COLUMNS, taskWhere, type Session, type Task, type Workspace } from "@amo-studio/protocol";
import { COLUMN_NAMES, relativeTime, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";

export type Scope = { kind: "all" } | { kind: "area" } | { kind: "workspace"; id: string };

export function inScope(task: Task, scope: Scope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "area") return task.scope.kind === "area";
  return task.scope.kind === "workspace" && task.scope.workspaceId === scope.id;
}

interface BoardProps {
  tasks: readonly Task[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  scope: Scope;
  onOpen(task: Task): void;
  /** Unread mail and open decisions per task id. */
  mail?: ReadonlyMap<string, number>;
  decisions?: ReadonlyMap<string, number>;
}

/** Four columns; the person moves cards, agents never do. Cards are entry points and carry no buttons. */
export function Board({ tasks, sessions, workspaces, scope, onOpen, mail, decisions }: BoardProps) {
  const visible = tasks.filter((t) => inScope(t, scope)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <section className="board" aria-label="看板">
      {TASK_COLUMNS.map((col) => {
        const cards = visible.filter((t) => t.column === col);
        return (
          <div className="column" key={col} data-testid={`column-${col}`}>
            <div className="column-head">
              <span className="column-name">{COLUMN_NAMES[col]}</span>
              <span className="column-count">{cards.length}</span>
            </div>
            {cards.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                sessions={taskSessions(task, sessions)}
                scope={scope}
                workspaces={workspaces}
                onOpen={onOpen}
                mail={mail?.get(task.id) ?? 0}
                decisions={decisions?.get(task.id) ?? 0}
              />
            ))}
            {cards.length === 0 && <div className="empty-col">空</div>}
          </div>
        );
      })}
    </section>
  );
}

function TaskCard({
  task,
  sessions,
  scope,
  workspaces,
  onOpen,
  mail = 0,
  decisions = 0,
}: {
  task: Task;
  sessions: Session[];
  scope: Scope;
  workspaces: readonly Workspace[];
  onOpen(t: Task): void;
  mail?: number;
  decisions?: number;
}) {
  const status = taskStatus(sessions);
  const look = status ? SESSION_LOOK[status] : null;
  const live = sessions.filter((s) => !s.archivedAt);
  const mains = live.filter((s) => s.kind === "main");
  const branches = live.length - mains.length;

  let where = "";
  if (task.scope.kind === "area" || scope.kind === "all") where = taskWhere(task, sessions, workspaces);
  const meta = [where, mains.length ? `${mains.length} 个会话` : "还没有会话", branches ? `${branches} 个分支` : ""].filter(Boolean).join(" · ");
  // Collaboration hints are counts in the meta line, not a second status: the dot keeps one status per card.
  const asks = [decisions ? `${decisions} 个待决策` : "", mail ? `${mail} 条留言` : ""].filter(Boolean).join(" · ");

  return (
    <button type="button" className="card" onClick={() => onOpen(task)} data-testid="task-card">
      <span className="card-title">{task.title || "未命名任务"}</span>
      <span className="card-status">
        {look ? (
          <>
            <span className="dot" style={{ background: look.dot }} />
            <span style={{ color: look.text }}>{look.label}</span>
          </>
        ) : (
          <>
            <span className="dot" style={{ background: "var(--muted-dot)" }} />
            <span>未开始</span>
          </>
        )}
        <span className="spacer" />
        <span>{relativeTime(task.updatedAt)}</span>
      </span>
      <span className="card-meta">{meta}</span>
      {asks && (
        <span className="card-asks" data-testid="card-asks">
          {asks}
        </span>
      )}
    </button>
  );
}
