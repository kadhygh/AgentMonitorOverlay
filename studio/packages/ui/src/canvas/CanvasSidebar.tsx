import { useEffect, useRef, useState, type ReactNode } from "react";
import { projectWorkspaces, taskWhere, wouldCycle, type CanvasDoc, type CanvasEdge, type Id, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { COLUMN_NAMES, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { deleteGroup, updateGroup } from "./geometry.js";

export type CanvasSelection = { kind: "node"; id: Id } | { kind: "group"; id: Id } | null;
export type SidebarTab = "todo" | "detail" | "docs" | "marks" | "agent";

interface CanvasSidebarProps {
  doc: CanvasDoc;
  selection: CanvasSelection;
  tasks: readonly Task[];
  /** Every task and topic, for reference cards. */
  allTasks?: readonly Task[];
  topics?: readonly Topic[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  tab: SidebarTab;
  onTab(tab: SidebarTab): void;
  onChange(next: CanvasDoc): void;
  /** A change made on the canvas as it is when it lands (typed text saved late must not undo a move made meanwhile). */
  onEdit(apply: (doc: CanvasDoc) => CanvasDoc): void;
  onClearSelection(): void;
  onOpenTask(taskId: Id): void;
  /** Write a task's description (the dialog). */
  onDescribe?(taskId: Id): void;
  newId(prefix: string): string;
  /** Rendered for the "整体待办" and "agent 视角" tabs (S3-05). */
  todoTab?: ReactNode;
  agentTab?: ReactNode;
  /** 文档 (stage 16): the topic's documents. */
  docsTab?: ReactNode;
  /** 书签 (2026-10-19): the topic's bookmarks. */
  marksTab?: ReactNode;
}

/** Right column of the canvas: whole-picture todos, details of the selection, and the agent's view. */
export function CanvasSidebar(props: CanvasSidebarProps) {
  const { tab, onTab } = props;
  // 整体待办 belongs to the planning feature: no tab while it is turned off.
  const tabs: Array<[SidebarTab, string]> = [
    ...(props.todoTab ? ([["todo", "整体待办"]] as Array<[SidebarTab, string]>) : []),
    ["detail", "详情"],
    ...(props.docsTab ? ([["docs", "文档"]] as Array<[SidebarTab, string]>) : []),
    ...(props.marksTab ? ([["marks", "书签"]] as Array<[SidebarTab, string]>) : []),
    ["agent", "agent 视角"],
  ];
  return (
    <aside className="canvas-side" aria-label="画布侧栏">
      <div role="tablist" aria-label="侧栏" className="side-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="side-tab" onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "detail" && <DetailTab {...props} />}
      {tab === "todo" && props.todoTab}
      {tab === "docs" && props.docsTab}
      {tab === "marks" && props.marksTab}
      {tab === "agent" && (props.agentTab ?? <span className="anno-empty">agent 视角在 S3-05 实现。</span>)}
    </aside>
  );
}

function DetailTab({ doc, selection, tasks, allTasks = tasks, topics = [], sessions, workspaces, onChange, onEdit, onClearSelection, onOpenTask, onDescribe, newId }: CanvasSidebarProps) {
  if (!selection) return <span className="anno-empty">在画布上点一个任务、便签，或点分组的标题栏。</span>;

  if (selection.kind === "group") {
    const group = doc.groups.find((g) => g.id === selection.id);
    if (!group) return null;
    return (
      <div className="side-section" role="group" aria-label="分组设置">
        <span className="side-heading">分组</span>
        <label className="stack-field">
          名称
          <KeptInput
            key={group.id + group.title}
            value={group.title}
            label="分组名称"
            onKeep={(text) => {
              const title = text.trim();
              if (title) onEdit((d) => (d.groups.find((g) => g.id === group.id)?.title === title ? d : updateGroup(d, group.id, { title })));
            }}
          />
        </label>
        <label className="stack-field">
          绑定项目
          <select value={group.workspaceId ?? ""} onChange={(e) => onChange(updateGroup(doc, group.id, { workspaceId: e.target.value || null }))}>
            <option value="">不绑定</option>
            {projectWorkspaces(workspaces).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <span className="side-note">{doc.nodes.filter((n) => n.groupId === group.id).length} 张卡片在组内</span>
        <button
          type="button"
          className="btn-ghost small dim"
          onClick={() => {
            onChange(deleteGroup(doc, group.id));
            onClearSelection();
          }}
        >
          删除分组（保留卡片）
        </button>
      </div>
    );
  }

  const node = doc.nodes.find((n) => n.id === selection.id);
  if (!node) return null;

  if (node.kind === "note") {
    return (
      <div className="side-section" role="group" aria-label="便签">
        <span className="side-heading">便签</span>
        <KeptInput
          key={node.id}
          multiline
          value={node.text}
          label="便签内容"
          onKeep={(text) =>
            onEdit((d) => (d.nodes.some((n) => n.id === node.id && n.kind === "note" && n.text !== text) ? { ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, text } : n)) } : d))
          }
        />
        <button
          type="button"
          className="btn-ghost small dim"
          onClick={() => {
            onChange({ ...doc, nodes: doc.nodes.filter((n) => n.id !== node.id) });
            onClearSelection();
          }}
        >
          删除便签
        </button>
      </div>
    );
  }

  if (node.kind === "ref") {
    const target = allTasks.find((t) => t.id === node.taskId);
    const refStatus = target && !target.archivedAt ? taskStatus(taskSessions(target, sessions)) : null;
    const refLook = refStatus ? SESSION_LOOK[refStatus] : null;
    return (
      <div className="side-section" role="group" aria-label="引用卡片">
        <span className="side-heading">{target ? target.title || "未命名任务" : "任务不存在"}</span>
        {target ? (
          <span className="side-note">
            引用 · {target.archivedAt ? "任务已归档" : <span style={{ color: refLook?.text }}>{refLook?.label ?? "未开始"}</span>} · 专题{" "}
            {topics.find((t) => t.id === target.topicId)?.title ?? "（无）"} · {taskWhere(target, workspaces)}
          </span>
        ) : (
          <span className="side-note">引用的任务已经不在了。</span>
        )}
        <span className="side-note">引用卡片只是指向任务：任务的项目和专题不变，删掉卡片也不影响任务。</span>
        {target && !target.archivedAt && <TaskDescription task={target} onDescribe={onDescribe} />}
        {target && (
          <button type="button" className="btn-ghost small" onClick={() => onOpenTask(target.id)}>
            打开任务
          </button>
        )}
        <button
          type="button"
          className="btn-ghost small dim"
          onClick={() => {
            onChange({ ...doc, nodes: doc.nodes.filter((n) => n.id !== node.id) });
            onClearSelection();
          }}
        >
          删除引用卡片（任务不变）
        </button>
      </div>
    );
  }

  const task = tasks.find((t) => t.id === node.taskId);
  const archived = task ? undefined : allTasks.find((t) => t.id === node.taskId && t.archivedAt);
  if (archived) {
    return (
      <div className="side-section" role="group" aria-label="任务详情">
        <span className="side-heading">{archived.title || "未命名任务"}</span>
        <span className="side-note">已归档 · 只读 · {taskWhere(archived, workspaces)}</span>
        {archived.description && <p className="side-desc-text">{archived.description}</p>}
        <button type="button" className="btn-ghost small" onClick={() => onOpenTask(archived.id)}>
          打开任务（只读）
        </button>
        <button
          type="button"
          className="btn-ghost small dim"
          title="只拿掉卡片：任务仍是归档状态"
          onClick={() => {
            onChange({ ...doc, nodes: doc.nodes.filter((n) => n.id !== node.id) });
            onClearSelection();
          }}
        >
          从画布上拿掉
        </button>
      </div>
    );
  }
  if (!task) return null;
  const status = taskStatus(taskSessions(task, sessions));
  const look = status ? SESSION_LOOK[status] : null;
  const title = (id: Id) => allTasks.find((t) => t.id === id)?.title || "未命名任务";
  const before = doc.edges.filter((e) => e.to === task.id);
  const candidates = tasks.filter((t) => t.id !== task.id && !before.some((e) => e.from === t.id) && !wouldCycle(doc.edges, t.id, task.id));

  return (
    <div className="side-section" role="group" aria-label="任务详情">
      <span className="side-heading">{task.title || "未命名任务"}</span>
      <span className="side-note">
        {COLUMN_NAMES[task.column]} · <span style={{ color: look?.text }}>{look?.label ?? "未开始"}</span> ·{" "}
        {taskWhere(task, workspaces)}
      </span>
      <TaskDescription task={task} onDescribe={onDescribe} />
      <button type="button" className="btn-ghost small" onClick={() => onOpenTask(task.id)}>
        打开任务
      </button>
      <button
        type="button"
        className="btn-ghost small dim"
        title="只拿掉卡片：任务仍在专题里，依赖也保留；在任务页可以再放回来"
        onClick={() => {
          onChange({ ...doc, nodes: doc.nodes.filter((n) => n.id !== node.id) });
          onClearSelection();
        }}
      >
        从画布上拿掉（任务不变）
      </button>
      <span className="side-subheading">前置任务</span>
      {before.length === 0 && <span className="side-note">没有前置任务。</span>}
      {before.map((e) => (
        <div key={e.id} className="dep-row" data-testid="dependency">
          <span className="name">{title(e.from)}</span>
          <button type="button" className="link-btn" aria-label={`移除前置任务 ${title(e.from)}`} onClick={() => onChange({ ...doc, edges: doc.edges.filter((x) => x.id !== e.id) })}>
            移除
          </button>
        </div>
      ))}
      <AddDependency
        candidates={candidates}
        onAdd={(from) => {
          const edge: CanvasEdge = { id: newId("e"), kind: "depends", from, to: task.id };
          onChange({ ...doc, edges: [...doc.edges, edge] });
        }}
      />
    </div>
  );
}

/** The task's description, and the way to write it. */
function TaskDescription({ task, onDescribe }: { task: Task; onDescribe?: ((taskId: Id) => void) | undefined }) {
  return (
    <div className="side-desc" data-testid="side-description">
      {task.description ? <p className="side-desc-text">{task.description}</p> : <span className="side-note">还没有说明。</span>}
      {onDescribe && (
        <button type="button" className="link-btn" onClick={() => onDescribe(task.id)}>
          {task.description ? "编辑说明" : "添加说明"}
        </button>
      )}
    </div>
  );
}

function AddDependency({ candidates, onAdd }: { candidates: readonly Task[]; onAdd(taskId: Id): void }) {
  const [value, setValue] = useState("");
  if (!candidates.length) return <span className="side-note">没有可以设为前置的任务（会成环的已排除）。</span>;
  return (
    <div className="dep-add">
      <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="添加前置任务">
        <option value="">选择前置任务…</option>
        {candidates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title || "未命名任务"}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-ghost small"
        disabled={!value}
        onClick={() => {
          onAdd(value);
          setValue("");
        }}
      >
        添加
      </button>
    </div>
  );
}

/**
 * A field whose text is kept as it is typed (2026-10-15: a note typed in the sidebar was lost when the next click on the
 * canvas swapped the sidebar before the field lost focus): a note while typing pauses, and on blur or when the field
 * goes away; a single line (a group's name) on blur, Enter, or going away.
 */
function KeptInput({ value, label, multiline, onKeep }: { value: string; label: string; multiline?: boolean; onKeep(text: string): void }) {
  const pending = useRef<string | null>(null);
  const timer = useRef(0);
  const keep = useRef(onKeep);
  keep.current = onKeep;
  const flush = () => {
    window.clearTimeout(timer.current);
    const text = pending.current;
    pending.current = null;
    if (text !== null && text !== value) keep.current(text);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  const change = (text: string) => {
    pending.current = text;
    window.clearTimeout(timer.current);
    if (multiline) timer.current = window.setTimeout(() => flushRef.current(), 500);
  };
  return multiline ? (
    <textarea className="side-textarea" aria-label={label} defaultValue={value} rows={6} onChange={(e) => change(e.target.value)} onBlur={flush} />
  ) : (
    <input className="field" aria-label={label} defaultValue={value} onChange={(e) => change(e.target.value)} onBlur={flush} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}
