import { useState } from "react";
import { TASK_COLUMNS, taskProject, type RemoteState, type Session, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { copyStatus, grantsOf, useRemote, type CopyStatus } from "../remote/remote.js";
import { COLUMN_NAMES, relativeTime, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { ArchiveIcon } from "../task/Archived.js";
import { ArchivedTasks } from "./ArchivedTasks.js";
import { KindIcon } from "./KindIcon.js";
import { setGroupByTopic, useGroupByTopic } from "./prefs.js";

/** What the board shows: everything, one topic's tasks, or one project's. Archived tasks are never on the board. */
export type Scope = { kind: "all" } | { kind: "topic"; id: string } | { kind: "workspace"; id: string };

export function inScope(task: Task, scope: Scope): boolean {
  if (task.archivedAt) return false;
  if (scope.kind === "all") return true;
  if (scope.kind === "topic") return task.topicId === scope.id;
  return task.workspaceId === scope.id;
}

/** A column's cards under their topics (2026-10-19, 按专题分组): topics in the order their newest card comes, none last. */
export function topicGroups(cards: readonly Task[], topics: readonly Topic[]): Array<{ topic: Topic | null; tasks: Task[] }> {
  const groups = new Map<string, { topic: Topic | null; tasks: Task[] }>();
  const none: Task[] = [];
  for (const task of cards) {
    const topic = task.topicId ? topics.find((t) => t.id === task.topicId) : undefined;
    if (!topic) {
      none.push(task);
      continue;
    }
    const g = groups.get(topic.id);
    if (g) g.tasks.push(task);
    else groups.set(topic.id, { topic, tasks: [task] });
  }
  return [...groups.values(), ...(none.length ? [{ topic: null, tasks: none }] : [])];
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
  /** 归档已完成: 归档 at the right of the 完成 column's head archives its cards, the one on a topic group's head that group's (2026-10-28; a right-click menu before). */
  onArchive?(tasks: readonly Task[]): void;
  /** 远程 (step 2): where copies of remote tasks run and whether they can be reached; what this computer granted. */
  link?: HostLink;
}

/** Four columns; the person moves cards (drag a card onto another column), agents never do. Cards carry no buttons. */
export function Board({ tasks, sessions, workspaces, topics, scope, onOpen, onMove, mail, decisions, checklist, onArchive, link }: BoardProps) {
  const remote = useRemote(link ?? null);
  const visible = tasks.filter((t) => inScope(t, scope)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<TaskColumn | null>(null);
  const archive = (list: readonly Task[]) => {
    if (list.length) onArchive?.(list);
  };
  // 按专题分组: wherever the board holds more than one topic's tasks (not in a topic's own board).
  const groupOn = useGroupByTopic();
  const canGroup = scope.kind !== "topic";
  const grouped = canGroup && groupOn;

  const card = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      sessions={taskSessions(task, sessions)}
      scope={scope}
      grouped={grouped}
      workspaces={workspaces}
      topics={topics}
      onOpen={onOpen}
      remote={remote}
      // A copy of a remote task has the column its own computer gives it.
      draggable={!!onMove && !task.remote}
      onDragStart={() => setDragging(task)}
      onDragEnd={() => {
        setDragging(null);
        setOver(null);
      }}
      mail={mail?.get(task.id) ?? 0}
      decisions={decisions?.get(task.id) ?? 0}
      {...(checklist?.get(task.id) ? { checklist: checklist.get(task.id)! } : {})}
    />
  );

  return (
    <section className={canGroup ? "board with-tools" : "board"} aria-label="看板">
      {canGroup && (
        <div className="board-tools">
          <label className="board-toggle" title="每一列里，任务按专题分组排列；没归专题的排在最后">
            <input type="checkbox" checked={groupOn} onChange={(e) => setGroupByTopic(e.target.checked)} data-testid="board-group-topics" />
            按专题分组
          </label>
        </div>
      )}
      {TASK_COLUMNS.map((col) => {
        const cards = visible.filter((t) => t.column === col);
        const archivable = col === "done" && !!onArchive;
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
              {archivable && cards.length > 0 && (
                <button type="button" className="bar-btn labeled soft-danger column-archive" title={`归档全部已完成（${cards.length}）：任务和它们的会话一起归档；在「已归档」里能打开、恢复`} onClick={() => archive(cards)} data-testid="archive-done-all">
                  <ArchiveIcon size={14} />
                  全部归档
                </button>
              )}
            </div>
            {grouped
              ? topicGroups(cards, topics).map((g, i) => (
                  <div className="topic-group" key={g.topic?.id ?? ""} data-testid="topic-group" data-topic={g.topic?.title ?? ""} data-group-index={i}>
                    <div className={g.topic ? "topic-group-head" : "topic-group-head none"}>
                      <KindIcon kind="topic" />
                      <span className="topic-group-name">{g.topic?.title ?? "未归专题"}</span>
                      <span className="topic-group-count">{g.tasks.length}</span>
                      <span className="topic-group-rule" />
                      {archivable && (
                        <button type="button" className="bar-btn soft-danger group-archive" aria-label={`归档「${g.topic?.title ?? "未归专题"}」这一组`} title={`归档「${g.topic?.title ?? "未归专题"}」这一组（${g.tasks.length}）：任务和它们的会话一起归档`} onClick={() => archive(g.tasks)} data-testid="archive-done-group">
                          <ArchiveIcon size={13} />
                        </button>
                      )}
                    </div>
                    {g.tasks.map(card)}
                  </div>
                ))
              : cards.map(card)}
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
  grouped = false,
  workspaces,
  topics,
  onOpen,
  draggable = false,
  onDragStart,
  onDragEnd,
  mail = 0,
  decisions = 0,
  checklist,
  remote = null,
}: {
  remote?: RemoteState | null;
  task: Task;
  sessions: Session[];
  scope: Scope;
  /** Under its topic's group head: the card does not name the topic again. */
  grouped?: boolean;
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
  // 远程 (step 2): a copy says where it runs and whether that computer can be reached; a task of this computer says
  // which devices it is granted to.
  const copy: CopyStatus | null = copyStatus(task, remote);
  const off = !!copy && (copy.state === "offline" || copy.state === "revoked");
  const granted = grantsOf(remote, task.id);
  const live = sessions.filter((s) => !s.archivedAt);
  const mains = live.filter((s) => s.kind === "main");
  const branches = live.length - mains.length;

  // 归属行 (2026-10-19): 「专题 › 项目」 above the title, naming only what the scope (or the topic group) does not
  // already say. In 全部任务 a task in no topic says so; a task in the common space names no project.
  const project = scope.kind === "workspace" || copy ? null : (taskProject(task, workspaces)?.name ?? null);
  const showTopic = scope.kind !== "topic" && !grouped;
  const topic = showTopic && task.topicId ? (topics.find((t) => t.id === task.topicId)?.title ?? null) : null;
  const noTopic = showTopic && !topic && scope.kind === "all";
  const meta = [mains.length ? `${mains.length} 个会话` : "还没有会话", branches ? `${branches} 个分支` : "", checklist ? `清单 ${checklist.done}/${checklist.total}` : ""].filter(Boolean).join(" · ");
  // Collaboration hints are counts in the meta line, not a second status: the dot keeps one status per card.
  const asks = [decisions ? `${decisions} 个待决策` : "", mail ? `${mail} 条留言` : ""].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className={off ? "card remote-off" : "card"}
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
      {...(copy ? { "data-remote": copy.state } : {})}
    >
      {copy && (
        <span className="card-where card-remote" data-testid="card-remote" title={`在 ${copy.name}（${task.remote!.account}）上运行：模型调用和命令都在那台电脑上`}>
          <span className="remote-badge">远程</span>
          <span className="card-remote-where">{off ? copy.label : `在 ${copy.name} 上`}</span>
        </span>
      )}
      {(topic || noTopic || project) && !copy && (
        <span className="card-where" data-testid="card-where">
          {topic && (
            <span className="card-topic" title={`专题：${topic}`}>
              <KindIcon kind="topic" />
              {topic}
            </span>
          )}
          {noTopic && <span className="card-topic none">未归专题</span>}
          {(topic || noTopic) && project && (
            <span className="card-where-sep" aria-hidden="true">
              ›
            </span>
          )}
          {project && (
            <span className="card-project" title={`项目：${project}`}>
              <KindIcon kind="workspace" />
              <span className="card-project-name">{project}</span>
            </span>
          )}
        </span>
      )}
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
      {granted.length > 0 && (
        <span className="card-granted" data-testid="card-granted" title="这个任务授权给了你的其他设备远程使用（任务页的 ⋯ 或顶栏的「远程」里可以收回）">
          已授权给 {granted.map((g) => g.name).join("、")}
        </span>
      )}
    </button>
  );
}
