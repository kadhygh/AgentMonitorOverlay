import { useState } from "react";
import { TASK_COLUMNS, taskProject, type Session, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import { COLUMN_NAMES, relativeTime, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { ArchivedTasks } from "./ArchivedTasks.js";

/** What the board shows: everything, one topic's tasks, or one project's. Archived tasks are never on the board. */
export type Scope = { kind: "all" } | { kind: "topic"; id: string } | { kind: "workspace"; id: string };

export function inScope(task: Task, scope: Scope): boolean {
  if (task.archivedAt) return false;
  if (scope.kind === "all") return true;
  if (scope.kind === "topic") return task.topicId === scope.id;
  return task.workspaceId === scope.id;
}

interface BoardProps {
  tasks: readonly Task[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  scope: Scope;
  onOpen(task: Task): void;
  /** A card dropped on another column (the person moves cards; agents never do). */
  onMove?(task: Task, column: TaskColumn): void;
  /** Unread mail and open decisions per task id. */
  mail?: ReadonlyMap<string, number>;
  decisions?: ReadonlyMap<string, number>;
  /** Checklist progress per task id (tasks made from a pack template). */
  checklist?: ReadonlyMap<string, { done: number; total: number }>;
}

/** Four columns; the person moves cards (drag a card onto another column), agents never do. Cards carry no buttons. */
export function Board({ tasks, sessions, workspaces, topics, scope, onOpen, onMove, mail, decisions, checklist }: BoardProps) {
  const visible = tasks.filter((t) => inScope(t, scope)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<TaskColumn | null>(null);

  return (
    <section className="board" aria-label="看板">
      {TASK_COLUMNS.map((col) => {
        const cards = visible.filter((t) => t.column === col);
        return (
          <div
            className={over === col && dragging && dragging.column !== col ? "column drop" : "column"}
            key={col}
            data-testid={`column-${col}`}
            onDragOver={(e) => {
              if (!dragging || !onMove) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== col) setOver(col);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && onMove && dragging.column !== col) onMove(dragging, col);
              setDragging(null);
              setOver(null);
            }}
          >
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
                topics={topics}
                onOpen={onOpen}
                draggable={!!onMove}
                onDragStart={() => setDragging(task)}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                mail={mail?.get(task.id) ?? 0}
                decisions={decisions?.get(task.id) ?? 0}
                {...(checklist?.get(task.id) ? { checklist: checklist.get(task.id)! } : {})}
              />
            ))}
            {cards.length === 0 && <div className="empty-col">空</div>}
            {/* Archived tasks leave the board; the last column offers them. */}
            {col === TASK_COLUMNS[TASK_COLUMNS.length - 1] && <ArchivedTasks tasks={tasks} workspaces={workspaces} topics={topics} scope={scope} onOpen={onOpen} />}
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
  topics,
  onOpen,
  draggable = false,
  onDragStart,
  onDragEnd,
  mail = 0,
  decisions = 0,
  checklist,
}: {
  task: Task;
  sessions: Session[];
  scope: Scope;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  onOpen(t: Task): void;
  draggable?: boolean;
  onDragStart?(): void;
  onDragEnd?(): void;
  mail?: number;
  decisions?: number;
  checklist?: { done: number; total: number };
}) {
  const status = taskStatus(sessions);
  const look = status ? SESSION_LOOK[status] : null;
  const live = sessions.filter((s) => !s.archivedAt);
  const mains = live.filter((s) => s.kind === "main");
  const branches = live.length - mains.length;

  // The card names what the current scope does not already say; a task without a project shows none.
  const project = scope.kind === "workspace" ? null : taskProject(task, workspaces)?.name;
  const topic = scope.kind === "topic" || !task.topicId ? null : topics.find((t) => t.id === task.topicId)?.title;
  const meta = [project ?? "", topic ? `专题 ${topic}` : "", mains.length ? `${mains.length} 个会话` : "还没有会话", branches ? `${branches} 个分支` : "", checklist ? `清单 ${checklist.done}/${checklist.total}` : ""]
    .filter(Boolean)
    .join(" · ");
  // Collaboration hints are counts in the meta line, not a second status: the dot keeps one status per card.
  const asks = [decisions ? `${decisions} 个待决策` : "", mail ? `${mail} 条留言` : ""].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className="card"
      onClick={() => onOpen(task)}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
      data-testid="task-card"
      data-task-id={task.id}
    >
      <span className="card-title">
        {task.lead && (
          <span className="lead-badge" title="主控：协调这个专题（或项目）的任务" data-testid="lead-badge">
            主控
          </span>
        )}
        {task.title || "未命名任务"}
      </span>
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
