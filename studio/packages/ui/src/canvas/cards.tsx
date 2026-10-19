import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { taskWhere, type CanvasNode, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";

// The canvas's cards (stage 16 split out of CanvasPage.tsx): a task of the topic, a reference to another topic's task,
// and a note. A task's description shows on its card (two lines); a colour mark is its outline (data-color).

export const CARD_W = 220;
export const CARD_H = 66;
/** A card with a description: two more lines. */
export const CARD_H_DESC = 102;
export const NOTE_W = 180;
export const NOTE_H = 90;

/** How tall a task's card is (edges and placement go by it). */
export const cardHeight = (task: Task | undefined) => (task?.description ? CARD_H_DESC : CARD_H);

interface CardEvents {
  selected: boolean;
  /** 连线's four side handles (2026-10-19). */
  handles?: ReactNode;
  onMouseDown(e: ReactMouseEvent): void;
  onContextMenu(e: ReactMouseEvent): void;
}

export function TaskCard({ node, task, sessions, workspaces, selected, linking, handles, onOpen, onMouseDown, onContextMenu }: CardEvents & { node: CanvasNode; task: Task; sessions: readonly Session[]; workspaces: readonly Workspace[]; linking: boolean; onOpen(): void }) {
  const own = taskSessions(task, sessions);
  const status = taskStatus(own);
  const look = status ? SESSION_LOOK[status] : null;
  const live = own.filter((s) => !s.archivedAt).length;
  const where = taskWhere(task, workspaces);
  return (
    <div
      className={`canvas-card${selected ? " selected" : ""}${linking ? " link-target" : ""}`}
      style={{ left: node.pos.x, top: node.pos.y, width: CARD_W, height: cardHeight(task) }}
      role="button"
      tabIndex={0}
      aria-label={task.title || "未命名任务"}
      data-testid="canvas-card"
      data-node-id={node.id}
      data-group-id={node.groupId ?? ""}
      data-color={node.color}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <span className="canvas-card-title">
        {task.lead && (
          <span className="lead-badge" title="主控：协调这个专题的任务" data-testid="lead-badge">
            主控
          </span>
        )}
        {task.title || "未命名任务"}
      </span>
      <span className="canvas-card-meta">
        <span className="dot" style={{ background: look?.dot ?? "var(--muted-dot)" }} />
        <span style={{ color: look?.text ?? "var(--text-dim)" }}>{look?.label ?? "未开始"}</span>
        <span>· {[where, live ? `${live} 个会话` : ""].filter(Boolean).join(" · ")}</span>
      </span>
      {task.description && (
        <span className="canvas-card-desc" title={task.description} data-testid="canvas-card-desc">
          {task.description}
        </span>
      )}
      {handles}
    </div>
  );
}

export function RefCard({ node, target, topics, sessions, workspaces, selected, handles, onOpen, onMouseDown, onContextMenu }: CardEvents & { node: CanvasNode; target: Task | undefined; topics: readonly Topic[]; sessions: readonly Session[]; workspaces: readonly Workspace[]; onOpen(): void }) {
  const gone = !target ? "任务不存在" : target.archivedAt ? "任务已归档" : "";
  const refStatus = target && !gone ? taskStatus(taskSessions(target, sessions)) : null;
  const refLook = refStatus ? SESSION_LOOK[refStatus] : null;
  const home = target ? `${topics.find((t) => t.id === target.topicId)?.title ?? "不在专题里"} / ${taskWhere(target, workspaces)}` : "";
  const described = !gone && target?.description;
  return (
    <div
      className={`canvas-card canvas-ref${gone ? " gone" : ""}${selected ? " selected" : ""}`}
      style={{ left: node.pos.x, top: node.pos.y, width: CARD_W, height: described ? CARD_H_DESC : CARD_H }}
      role="button"
      tabIndex={0}
      aria-label={`引用 ${target?.title || "未命名任务"}`}
      title={gone ? "引用的任务已不在了；删掉这张卡片即可" : "引用卡片：任务属于别的专题，删掉卡片不影响任务"}
      data-testid="canvas-ref"
      data-node-id={node.id}
      data-group-id={node.groupId ?? ""}
      data-color={node.color}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <span className="canvas-card-title">
        <span className="ref-mark">引用</span>
        {gone && target ? `${gone} · ${target.title || "未命名任务"}` : gone || target?.title || "未命名任务"}
      </span>
      <span className="canvas-card-meta">
        {!gone && <span className="dot" style={{ background: refLook?.dot ?? "var(--muted-dot)" }} />}
        {!gone && <span style={{ color: refLook?.text ?? "var(--text-dim)" }}>{refLook?.label ?? "未开始"}</span>}
        <span className="ref-home">{gone ? "可以删掉这张卡片" : `· ${home}`}</span>
      </span>
      {described && (
        <span className="canvas-card-desc" title={target.description}>
          {target.description}
        </span>
      )}
      {handles}
    </div>
  );
}

export function NoteCard({ node, selected, handles, onMouseDown, onContextMenu, onEdit }: CardEvents & { node: Extract<CanvasNode, { kind: "note" }>; onEdit(): void }) {
  return (
    <div
      className={selected ? "canvas-note selected" : "canvas-note"}
      style={{ left: node.pos.x, top: node.pos.y, width: NOTE_W, minHeight: NOTE_H }}
      data-testid="canvas-note"
      data-node-id={node.id}
      data-group-id={node.groupId ?? ""}
      data-color={node.color}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onEdit}
    >
      {node.text || <span className="dim">空便签，双击或在侧栏编辑</span>}
      {handles}
    </div>
  );
}
