import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { taskWhere, workspacesActivity, type CanvasDoc, type CanvasGroup, type CanvasNode, type Id, type ModelProfile, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { CanvasSidebar, type CanvasSelection, type SidebarTab } from "./CanvasSidebar.js";
import { AgentTab } from "./AgentTab.js";
import { TodoTab } from "../planning/TodoTab.js";
import { useFeature } from "../lib/features.js";
import type { HostLink } from "../host/client.js";
import { SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { addGroup, arrowBetween, deleteGroup, GROUP_HEADER, moveGroup, moveNode, resizeGroup, updateGroup } from "./geometry.js";
import { useCanvas } from "./useCanvas.js";
import { RefPicker, type RefChoice } from "./RefPicker.js";

export const CARD_W = 220;
export const CARD_H = 66;
export const NOTE_W = 180;
export const NOTE_H = 90;
const nodeSize = (n: CanvasNode) => (n.kind === "note" ? { w: NOTE_W, h: NOTE_H } : { w: CARD_W, h: CARD_H });
const MIN_K = 0.3;
const MAX_K = 2.5;
const VIEW_KEY = "amo.canvasView";

interface View {
  x: number;
  y: number;
  k: number;
}


type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "node"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean }
  | { kind: "group-move"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean }
  | { kind: "group-resize"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean };

function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "") as View;
    if ([v.x, v.y, v.k].every(Number.isFinite)) return v;
  } catch {
    // per-viewer convenience only
  }
  return { x: 0, y: 0, k: 1 };
}

function saveView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    // ignore
  }
}

let idCounter = 0;
export const newCanvasId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

interface CanvasPageProps {
  link: HostLink;
  /** For "转为任务" (the new task's model). */
  profiles?: readonly ModelProfile[];
  /** The topic whose canvas this is; `tasks` are its live tasks. */
  topic: Topic;
  tasks: readonly Task[];
  /** Every task (archived too) and topic: what reference cards point at, and the "引用任务" list. */
  allTasks?: readonly Task[];
  topics?: readonly Topic[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  onOpenTask(taskId: Id, sessionId?: Id): void;
  /** "在专题里新建任务": the draft task page with this topic picked. */
  onNewTask?(): void;
}

export function CanvasPage({ link, topic, tasks, allTasks = tasks, topics = [topic], sessions, workspaces, profiles = [], onOpenTask, onNewTask }: CanvasPageProps) {
  const { doc, save, conflict, dismissConflict, error, dismissError } = useCanvas(link, topic.id);
  const [view, setView] = useState<View>(loadView);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreviewState] = useState<CanvasDoc | null>(null);
  const previewRef = useRef<CanvasDoc | null>(null);
  const setPreview = (next: CanvasDoc | null) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  const [selection, setSelectionState] = useState<CanvasSelection>(null);
  const [tab, setTab] = useState<SidebarTab>("detail");
  const planning = useFeature("planning");
  const setSelection = (next: CanvasSelection) => {
    setSelectionState(next);
    if (next) setTab("detail");
  };
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [picking, setPicking] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => saveView(view), [view]);

  const persist = useCallback((next: CanvasDoc) => void save(next).catch(() => undefined), [save]);

  // Delete / Backspace removes the selected group (its cards stay), note or reference card (never the task itself),
  // unless typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "Delete" && e.key !== "Backspace") || !doc || !selection) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (selection.kind === "group") {
        e.preventDefault();
        persist(deleteGroup(doc, selection.id));
        setSelectionState(null);
      } else if (doc.nodes.some((n) => n.id === selection.id && (n.kind === "note" || n.kind === "ref"))) {
        e.preventDefault();
        persist({ ...doc, nodes: doc.nodes.filter((n) => n.id !== selection.id) });
        setSelectionState(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, selection, persist]);

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  }, []);

  // Wheel zoom around the cursor (native listener: React's onWheel is passive and cannot prevent scrolling).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".ref-picker")) return; // the task list scrolls
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomAt(e.clientX - box.left, e.clientY - box.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const zoomCenter = (factor: number) => {
    const box = viewport.current?.getBoundingClientRect();
    zoomAt((box?.width ?? 800) / 2, (box?.height ?? 600) / 2, factor);
  };

  // Dragging: window listeners so the pointer can leave the element or the viewport. Layout effect: the listeners must
  // be in place before the next pointer event, or a fast drag ends before it is seen.
  useLayoutEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      if (drag.kind === "pan") {
        setView((v) => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }));
        return;
      }
      const dx = Math.round((e.clientX - drag.sx) / view.k);
      const dy = Math.round((e.clientY - drag.sy) / view.k);
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      if (drag.kind === "node") {
        const node = drag.base.nodes.find((n) => n.id === drag.id)!;
        setPreview(moveNode(drag.base, drag.id, { x: node.pos.x + dx, y: node.pos.y + dy }, nodeSize(node)));
      } else if (drag.kind === "group-move") {
        setPreview(moveGroup(drag.base, drag.id, dx, dy));
      } else {
        const g = drag.base.groups.find((x) => x.id === drag.id)!;
        setPreview(resizeGroup(drag.base, drag.id, g.rect.w + dx, g.rect.h + dy));
      }
    };
    const onUp = () => {
      if (drag.kind !== "pan" && drag.moved && previewRef.current) persist(previewRef.current);
      setPreview(null);
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, persist, view.k]);

  const shown = preview ?? doc;

  // preventDefault on every drag start: a leftover text selection would otherwise turn the gesture into a native
  // drag-and-drop, which swallows the mousemove/mouseup events the canvas listens to.
  const startPan = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setSelection(null);
    setPicking(false);
    setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
  };

  const startDrag = (e: ReactMouseEvent, kind: "node" | "group-move" | "group-resize", id: Id) => {
    if (e.button !== 0 || !doc) return;
    e.preventDefault();
    e.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur?.(); // commit any open field (e.g. the group name)
    setSelection({ kind: kind === "node" ? "node" : "group", id });
    setDrag({ kind, id, sx: e.clientX, sy: e.clientY, base: doc, moved: false });
  };

  /** New group in the middle of the visible area. */
  const newGroup = () => {
    if (!doc) return;
    const box = viewport.current?.getBoundingClientRect();
    const cx = ((box?.width ?? 800) / 2 - view.x) / view.k;
    const cy = ((box?.height ?? 600) / 2 - view.y) / view.k;
    const group: CanvasGroup = { id: newCanvasId("g"), title: "新分组", workspaceId: null, rect: { x: Math.round(cx - 210), y: Math.round(cy - 150), w: 420, h: 300 } };
    persist(addGroup(doc, group));
    setSelection({ kind: "group", id: group.id });
  };

  /** New note in the middle of the visible area. */
  const newNote = () => {
    if (!doc) return;
    const box = viewport.current?.getBoundingClientRect();
    const x = Math.round(((box?.width ?? 800) / 2 - view.x) / view.k - NOTE_W / 2);
    const y = Math.round(((box?.height ?? 600) / 2 - view.y) / view.k - NOTE_H / 2);
    const id = newCanvasId("n");
    persist(moveNode({ ...doc, nodes: [...doc.nodes, { id, kind: "note", text: "", groupId: null, pos: { x, y } }] }, id, { x, y }, { w: NOTE_W, h: NOTE_H }));
    setSelection({ kind: "node", id });
  };

  /**
   * "引用任务": a reference card for another topic's task, or this topic's own task placed as its card, in the middle of
   * the visible area (moved down while it would cover another card; inside a group if it lands in one).
   */
  const addPicked = (choice: RefChoice) => {
    if (!doc) return;
    const box = viewport.current?.getBoundingClientRect();
    const x = Math.round(((box?.width ?? 800) / 2 - view.x) / view.k - CARD_W / 2);
    let y = Math.round(((box?.height ?? 600) / 2 - view.y) / view.k - CARD_H / 2);
    for (let i = 0; i < 40 && doc.nodes.some((n) => Math.abs(n.pos.x - x) < CARD_W && Math.abs(n.pos.y - y) < CARD_H); i++) y += CARD_H + 12;
    const id = newCanvasId("n");
    const node: CanvasNode = { id, kind: choice.kind === "ref" ? "ref" : "task", taskId: choice.taskId, groupId: null, pos: { x, y } };
    persist(moveNode({ ...doc, nodes: [...doc.nodes, node] }, id, { x, y }, { w: CARD_W, h: CARD_H }));
    setPicking(false);
    setSelection({ kind: "node", id });
  };

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const anyTaskById = new Map(allTasks.map((t) => [t.id, t]));
  const wsName = (id: Id | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "") : "");
  // Whether each bound project is free (design/scheduler.md): the scheduler only proposes work for free ones.
  const activity = workspacesActivity(workspaces, sessions);
  const cardOf = new Map(
    (shown?.nodes ?? []).filter((n) => n.kind === "task").map((n) => [(n as { taskId: Id }).taskId, { x: n.pos.x, y: n.pos.y, w: CARD_W, h: CARD_H }]),
  );

  return (
    <section className="canvas-page" aria-label="画布">
      {conflict && (
        <div role="status" className="toast" data-testid="canvas-conflict">
          <span>画布刚在别处更新过，已载入最新内容，刚才的改动没有保存。</span>
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={dismissConflict}>
            ×
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="toast toast-error" data-testid="canvas-error">
          <span>画布没有保存，已载入最新内容：{error}</span>
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={dismissError}>
            ×
          </button>
        </div>
      )}
      <div className="canvas-row">
      <div className={drag?.kind === "pan" ? "canvas-viewport panning" : "canvas-viewport"} ref={viewport} onMouseDown={startPan} data-testid="canvas-viewport">
        <div className="canvas-world" data-testid="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {shown?.groups.map((g) => (
            <div
              key={g.id}
              className={selection?.kind === "group" && selection.id === g.id ? "canvas-group selected" : "canvas-group"}
              style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}
              data-testid="canvas-group"
              data-group-id={g.id}
            >
              <div className="canvas-group-bar" style={{ height: GROUP_HEADER }} onMouseDown={(e) => startDrag(e, "group-move", g.id)} onDoubleClick={() => setRenaming(g.id)}>
                <span className="grip" aria-hidden="true">
                  ⠿
                </span>
                {renaming === g.id ? (
                  <input
                    className="group-rename"
                    aria-label="分组名称"
                    defaultValue={g.title}
                    autoFocus
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={(e) => {
                      setRenaming(null);
                      const title = e.target.value.trim();
                      if (doc && title && title !== g.title) persist(updateGroup(doc, g.id, { title }));
                    }}
                  />
                ) : (
                  <span className="group-title">{g.title}</span>
                )}
                {g.workspaceId && <span className="group-ws">· {wsName(g.workspaceId)}</span>}
                {g.workspaceId && activity.get(g.workspaceId) && (
                  <span className={activity.get(g.workspaceId)!.idle ? "group-activity idle" : "group-activity busy"} data-testid="group-activity">
                    {activity.get(g.workspaceId)!.idle ? "空闲" : `忙碌 · ${activity.get(g.workspaceId)!.busy} 个会话`}
                  </span>
                )}
                <button
                  type="button"
                  className="group-remove"
                  aria-label={`删除分组 ${g.title}（保留卡片）`}
                  title="删除分组（卡片留在画布上）"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    if (!doc) return;
                    persist(deleteGroup(doc, g.id));
                    if (selection?.kind === "group" && selection.id === g.id) setSelection(null);
                  }}
                  data-testid="group-remove"
                >
                  ×
                </button>
              </div>
              <div className="canvas-group-resize" aria-label="调整分组大小" onMouseDown={(e) => startDrag(e, "group-resize", g.id)} />
            </div>
          ))}
          <svg className="canvas-edges" aria-hidden="true">
            <defs>
              <marker id="amo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 Z" style={{ fill: "var(--edge)" }} />
              </marker>
            </defs>
            {shown?.edges.map((e) => {
              const from = cardOf.get(e.from);
              const to = cardOf.get(e.to);
              if (!from || !to) return null;
              const { a, b } = arrowBetween(from, to);
              return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="canvas-edge" markerEnd="url(#amo-arrow)" data-testid="canvas-edge" />;
            })}
          </svg>
          {shown?.nodes.map((node) => {
            if (node.kind === "note") {
              const noteSelected = selection?.kind === "node" && selection.id === node.id;
              return (
                <div
                  key={node.id}
                  className={noteSelected ? "canvas-note selected" : "canvas-note"}
                  style={{ left: node.pos.x, top: node.pos.y, width: NOTE_W, minHeight: NOTE_H }}
                  data-testid="canvas-note"
                  data-node-id={node.id}
                  data-group-id={node.groupId ?? ""}
                  onMouseDown={(e) => startDrag(e, "node", node.id)}
                >
                  {node.text || <span className="dim">空便签，在侧栏编辑</span>}
                </div>
              );
            }
            if (node.kind === "ref") {
              const target = anyTaskById.get(node.taskId);
              const gone = !target ? "任务不存在" : target.archivedAt ? "任务已归档" : "";
              const refStatus = target && !gone ? taskStatus(taskSessions(target, sessions)) : null;
              const refLook = refStatus ? SESSION_LOOK[refStatus] : null;
              const home = target ? `${topics.find((t) => t.id === target.topicId)?.title ?? "不在专题里"} / ${taskWhere(target, workspaces)}` : "";
              const open = () => target && onOpenTask(target.id);
              return (
                <div
                  key={node.id}
                  className={`canvas-card canvas-ref${gone ? " gone" : ""}${selection?.kind === "node" && selection.id === node.id ? " selected" : ""}`}
                  style={{ left: node.pos.x, top: node.pos.y, width: CARD_W }}
                  role="button"
                  tabIndex={0}
                  aria-label={`引用 ${target?.title || "未命名任务"}`}
                  title={gone ? "引用的任务已不在了；删掉这张卡片即可" : "引用卡片：任务属于别的专题，删掉卡片不影响任务"}
                  data-testid="canvas-ref"
                  data-node-id={node.id}
                  data-group-id={node.groupId ?? ""}
                  onMouseDown={(e) => startDrag(e, "node", node.id)}
                  onDoubleClick={open}
                  onKeyDown={(e) => e.key === "Enter" && open()}
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
                </div>
              );
            }
            const task = taskById.get(node.taskId);
            if (!task) return null;
            const own = taskSessions(task, sessions);
            const status = taskStatus(own);
            const look = status ? SESSION_LOOK[status] : null;
            const live = own.filter((s) => !s.archivedAt).length;
            const where = taskWhere(task, workspaces);
            const isSelected = selection?.kind === "node" && selection.id === node.id;
            return (
              <div
                key={node.id}
                className={isSelected ? "canvas-card selected" : "canvas-card"}
                style={{ left: node.pos.x, top: node.pos.y, width: CARD_W }}
                role="button"
                tabIndex={0}
                aria-label={task.title || "未命名任务"}
                data-testid="canvas-card"
                data-node-id={node.id}
                data-group-id={node.groupId ?? ""}
                onMouseDown={(e) => startDrag(e, "node", node.id)}
                onDoubleClick={() => onOpenTask(task.id)}
                onKeyDown={(e) => e.key === "Enter" && onOpenTask(task.id)}
              >
                <span className="canvas-card-title">{task.title || "未命名任务"}</span>
                <span className="canvas-card-meta">
                  <span className="dot" style={{ background: look?.dot ?? "var(--muted-dot)" }} />
                  <span style={{ color: look?.text ?? "var(--text-dim)" }}>{look?.label ?? "未开始"}</span>
                  <span>· {[where, live ? `${live} 个会话` : ""].filter(Boolean).join(" · ")}</span>
                </span>
              </div>
            );
          })}
        </div>

        <div className="canvas-tools" onMouseDown={(e) => e.stopPropagation()}>
          {onNewTask && (
            <button type="button" className="btn-primary small" onClick={onNewTask}>
              + 在专题里新建任务
            </button>
          )}
          <button type="button" className="btn-ghost small" onClick={newGroup} disabled={!doc}>
            + 分组
          </button>
          <button type="button" className="btn-ghost small" onClick={() => setPicking((v) => !v)} disabled={!doc} aria-expanded={picking}>
            引用任务
          </button>
          <button type="button" className="btn-ghost small" onClick={newNote} disabled={!doc}>
            + 便签
          </button>
        </div>

        {picking && doc && (
          <RefPicker
            doc={doc}
            topicId={topic.id}
            tasks={allTasks}
            topics={topics}
            sessions={sessions}
            workspaces={workspaces}
            onPick={addPicked}
            onClose={() => setPicking(false)}
          />
        )}

        <div className="canvas-zoom" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" aria-label="缩小" onClick={() => zoomCenter(1 / 1.2)}>
            −
          </button>
          <span data-testid="zoom-label">{Math.round(view.k * 100)}%</span>
          <button type="button" aria-label="放大" onClick={() => zoomCenter(1.2)}>
            +
          </button>
          <button type="button" className="canvas-reset" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
            复位
          </button>
        </div>
        <div className="canvas-hint">拖空白处平移 · 滚轮缩放 · 拖卡片进出分组 · 拖分组标题移动整组 · 右下角调整大小 · 双击打开任务</div>
      </div>
      {shown && (
        <CanvasSidebar
          doc={shown}
          selection={selection}
          tasks={tasks}
          allTasks={allTasks}
          topics={topics}
          sessions={sessions}
          workspaces={workspaces}
          tab={tab}
          onTab={setTab}
          onChange={persist}
          onClearSelection={() => setSelectionState(null)}
          onOpenTask={onOpenTask}
          newId={newCanvasId}
          todoTab={planning ? <TodoTab link={link} workspaces={workspaces} profiles={profiles} onOpenTask={onOpenTask} activity={activity} topicId={topic.id} /> : undefined}
          agentTab={<AgentTab link={link} topicId={topic.id} />}
        />
      )}
      </div>
    </section>
  );
}
