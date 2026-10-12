import { useState, type ReactNode } from "react";
import { wouldCycle, type CanvasDoc, type CanvasEdge, type Id, type Session, type Task, type Workspace } from "@amo-studio/protocol";
import { COLUMN_NAMES, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { deleteGroup, updateGroup } from "./geometry.js";

export type CanvasSelection = { kind: "node"; id: Id } | { kind: "group"; id: Id } | null;
export type SidebarTab = "todo" | "detail" | "agent";

interface CanvasSidebarProps {
  doc: CanvasDoc;
  selection: CanvasSelection;
  tasks: readonly Task[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  tab: SidebarTab;
  onTab(tab: SidebarTab): void;
  onChange(next: CanvasDoc): void;
  onClearSelection(): void;
  onOpenTask(taskId: Id): void;
  newId(prefix: string): string;
  /** Rendered for the "整体待办" and "agent 视角" tabs (S3-05). */
  todoTab?: ReactNode;
  agentTab?: ReactNode;
}

/** Right column of the canvas: whole-picture todos, details of the selection, and the agent's view. */
export function CanvasSidebar(props: CanvasSidebarProps) {
  const { tab, onTab } = props;
  const tabs: Array<[SidebarTab, string]> = [
    ["todo", "整体待办"],
    ["detail", "详情"],
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
      {tab === "todo" && (props.todoTab ?? <span className="anno-empty">整体待办在 S3-05 实现。</span>)}
      {tab === "agent" && (props.agentTab ?? <span className="anno-empty">agent 视角在 S3-05 实现。</span>)}
    </aside>
  );
}

function DetailTab({ doc, selection, tasks, sessions, workspaces, onChange, onClearSelection, onOpenTask, newId }: CanvasSidebarProps) {
  if (!selection) return <span className="anno-empty">在画布上点一个任务、便签，或点分组的标题栏。</span>;

  if (selection.kind === "group") {
    const group = doc.groups.find((g) => g.id === selection.id);
    if (!group) return null;
    return (
      <div className="side-section" role="group" aria-label="分组设置">
        <span className="side-heading">分组</span>
        <label className="stack-field">
          名称
          <input
            key={group.id + group.title}
            className="field"
            defaultValue={group.title}
            aria-label="分组名称"
            onBlur={(e) => {
              const title = e.target.value.trim();
              if (title && title !== group.title) onChange(updateGroup(doc, group.id, { title }));
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <label className="stack-field">
          绑定工作区
          <select value={group.workspaceId ?? ""} onChange={(e) => onChange(updateGroup(doc, group.id, { workspaceId: e.target.value || null }))}>
            <option value="">不绑定</option>
            {workspaces.map((w) => (
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
        <textarea
          key={node.id}
          className="side-textarea"
          aria-label="便签内容"
          defaultValue={node.text}
          rows={6}
          onBlur={(e) => {
            if (e.target.value !== node.text) onChange({ ...doc, nodes: doc.nodes.map((n) => (n.id === node.id ? { ...n, text: e.target.value } : n)) });
          }}
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

  const task = tasks.find((t) => t.id === node.taskId);
  if (!task) return null;
  const status = taskStatus(taskSessions(task, sessions));
  const look = status ? SESSION_LOOK[status] : null;
  const title = (id: Id) => tasks.find((t) => t.id === id)?.title || "未命名任务";
  const before = doc.edges.filter((e) => e.to === task.id);
  const candidates = tasks.filter((t) => t.id !== task.id && !before.some((e) => e.from === t.id) && !wouldCycle(doc.edges, t.id, task.id));

  return (
    <div className="side-section" role="group" aria-label="任务详情">
      <span className="side-heading">{task.title || "未命名任务"}</span>
      <span className="side-note">
        {COLUMN_NAMES[task.column]} · <span style={{ color: look?.text }}>{look?.label ?? "未开始"}</span> ·{" "}
        {task.scope.kind === "area" ? "跨工作区" : (workspaces.find((w) => w.id === (task.scope as { workspaceId: string }).workspaceId)?.name ?? "")}
      </span>
      <button type="button" className="btn-ghost small" onClick={() => onOpenTask(task.id)}>
        打开任务
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
