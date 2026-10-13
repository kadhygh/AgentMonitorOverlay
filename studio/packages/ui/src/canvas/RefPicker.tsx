import { useEffect, useMemo, useState } from "react";
import { taskWhere, type CanvasDoc, type Id, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { COLUMN_NAMES, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";

/** What choosing a row does: reference another topic's task, or put one of this topic's own tasks on the canvas. */
export type RefChoice = { kind: "ref" | "place"; taskId: Id };

interface RefPickerProps {
  doc: CanvasDoc;
  /** The topic whose canvas this is. */
  topicId: Id;
  /** Every task (archived ones are left out here). */
  tasks: readonly Task[];
  topics: readonly Topic[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  onPick(choice: RefChoice): void;
  onClose(): void;
}

interface Row {
  task: Task;
  topic: string;
  where: string;
  /** null: already on this canvas. */
  action: RefChoice["kind"] | null;
  note: string;
}

/**
 * "引用任务" (S11-A): every live task, filtered by typing (title, project, topic). Another topic's task (or one in no
 * topic) is added as a reference card; one of this topic's own tasks not on the canvas yet gets its own card instead.
 */
export function RefPicker({ doc, topicId, tasks, topics, sessions, workspaces, onPick, onClose }: RefPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const rows = useMemo<Row[]>(() => {
    const placed = new Set(doc.nodes.flatMap((n) => (n.kind === "task" ? [n.taskId] : [])));
    const referenced = new Set(doc.nodes.flatMap((n) => (n.kind === "ref" ? [n.taskId] : [])));
    const topicTitle = (id: Id | null) => (id ? (topics.find((t) => t.id === id)?.title ?? "") : "");
    return tasks
      .filter((t) => !t.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((task) => {
        const own = task.topicId === topicId;
        const action = own ? (placed.has(task.id) ? null : "place") : referenced.has(task.id) ? null : "ref";
        const note = own ? (action ? "本专题 · 放上画布" : "本专题 · 已在画布上") : action ? "引用" : "已引用";
        return { task, topic: own ? "本专题" : topicTitle(task.topicId) || "不在专题里", where: taskWhere(task, workspaces), action, note };
      });
  }, [doc, tasks, topics, topicId, workspaces]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => words.every((w) => `${r.task.title} ${r.where} ${r.topic}`.toLowerCase().includes(w)));
  const pickable = shown.filter((r) => r.action);

  useEffect(() => setActive(0), [query]);

  const pick = (row: Row | undefined) => {
    if (row?.action) onPick({ kind: row.action, taskId: row.task.id });
  };

  return (
    <div className="ref-picker" role="dialog" aria-label="引用任务" onMouseDown={(e) => e.stopPropagation()}>
      <input
        className="field"
        autoFocus
        value={query}
        placeholder="搜任务名、项目或专题"
        aria-label="搜索任务"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (pickable.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : pickable.length - 1)) % pickable.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(pickable[active]);
          }
        }}
      />
      <div className="ref-list" role="listbox" aria-label="任务">
        {shown.length === 0 && <span className="side-note">没有对得上的任务。</span>}
        {shown.map((r) => {
          const status = taskStatus(taskSessions(r.task, sessions));
          const look = status ? SESSION_LOOK[status] : null;
          return (
            <button
              key={r.task.id}
              type="button"
              role="option"
              aria-selected={!!r.action && pickable[active] === r}
              className="ref-row"
              disabled={!r.action}
              onClick={() => pick(r)}
              data-testid="ref-option"
            >
              <span className="ref-row-title">{r.task.title || "未命名任务"}</span>
              <span className="ref-row-meta">
                <span className="dot" style={{ background: look?.dot ?? "var(--muted-dot)" }} />
                <span>{look?.label ?? COLUMN_NAMES[r.task.column]}</span>
                <span>
                  · {r.topic} · {r.where}
                </span>
              </span>
              <span className="ref-row-act">{r.note}</span>
            </button>
          );
        })}
      </div>
      <span className="side-note">引用卡片只是指向任务：任务的项目和专题不变，删掉卡片也不影响任务。</span>
    </div>
  );
}
