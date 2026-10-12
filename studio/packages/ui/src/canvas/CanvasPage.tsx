import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { CanvasDoc, CanvasGroup, CanvasNode, Id, Session, Task, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { addGroup, deleteGroup, GROUP_HEADER, moveGroup, moveNode, resizeGroup, updateGroup } from "./geometry.js";
import { useCanvas } from "./useCanvas.js";

export const CARD_W = 220;
export const CARD_H = 66;
const MIN_K = 0.3;
const MAX_K = 2.5;
const VIEW_KEY = "amo.canvasView";

interface View {
  x: number;
  y: number;
  k: number;
}

type Selection = { kind: "node"; id: Id } | { kind: "group"; id: Id } | null;

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

/** Places tasks that are not on the canvas yet in a grid below everything else (ungrouped). */
export function placeMissing(doc: CanvasDoc, tasks: readonly Task[]): CanvasDoc | null {
  const placed = new Set(doc.nodes.filter((n) => n.kind === "task").map((n) => (n as { taskId: Id }).taskId));
  const missing = tasks.filter((t) => !placed.has(t.id));
  if (!missing.length) return null;
  const bottoms = [...doc.nodes.map((n) => n.pos.y + CARD_H), ...doc.groups.map((g) => g.rect.y + g.rect.h)];
  const baseY = bottoms.length ? Math.max(...bottoms) + 40 : 40;
  const added: CanvasNode[] = missing.map((t, i) => ({
    id: newCanvasId("n"),
    kind: "task",
    taskId: t.id,
    groupId: null,
    pos: { x: 40 + (i % 4) * (CARD_W + 24), y: baseY + Math.floor(i / 4) * (CARD_H + 24) },
  }));
  return { ...doc, nodes: [...doc.nodes, ...added] };
}

interface CanvasPageProps {
  link: HostLink;
  tasks: readonly Task[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  onOpenTask(taskId: Id): void;
}

export function CanvasPage({ link, tasks, sessions, workspaces, onOpenTask }: CanvasPageProps) {
  const { doc, save, conflict, dismissConflict } = useCanvas(link);
  const [view, setView] = useState<View>(loadView);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreviewState] = useState<CanvasDoc | null>(null);
  const previewRef = useRef<CanvasDoc | null>(null);
  const setPreview = (next: CanvasDoc | null) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  const [selection, setSelection] = useState<Selection>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const placing = useRef(false);

  useEffect(() => saveView(view), [view]);

  const persist = useCallback((next: CanvasDoc) => void save(next).catch(() => undefined), [save]);

  // New tasks appear on the canvas automatically, ungrouped.
  useEffect(() => {
    if (!doc || placing.current || drag) return;
    const next = placeMissing(doc, tasks);
    if (!next) return;
    placing.current = true;
    void save(next)
      .catch(() => undefined)
      .finally(() => {
        placing.current = false;
      });
  }, [doc, tasks, save, drag]);

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
        setPreview(moveNode(drag.base, drag.id, { x: node.pos.x + dx, y: node.pos.y + dy }, { w: CARD_W, h: CARD_H }));
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

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const wsName = (id: Id | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "") : "");
  const selectedGroup = selection?.kind === "group" ? shown?.groups.find((g) => g.id === selection.id) : undefined;

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
              </div>
              <div className="canvas-group-resize" aria-label="调整分组大小" onMouseDown={(e) => startDrag(e, "group-resize", g.id)} />
            </div>
          ))}
          {shown?.nodes.map((node) => {
            if (node.kind !== "task") return null;
            const task = taskById.get(node.taskId);
            if (!task) return null;
            const own = taskSessions(task, sessions);
            const status = taskStatus(own);
            const look = status ? SESSION_LOOK[status] : null;
            const live = own.filter((s) => !s.archivedAt).length;
            const where = task.scope.kind === "area" ? "跨工作区" : wsName(task.scope.workspaceId);
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
          <button type="button" className="btn-ghost small" onClick={newGroup} disabled={!doc}>
            + 分组
          </button>
        </div>

        {selectedGroup && doc && (
          <div className="group-panel" role="dialog" aria-label="分组设置" onMouseDown={(e) => e.stopPropagation()}>
            <label className="stack-field">
              名称
              <input
                key={selectedGroup.id + selectedGroup.title}
                className="field"
                defaultValue={selectedGroup.title}
                aria-label="分组名称"
                onBlur={(e) => {
                  const title = e.target.value.trim();
                  if (title && title !== selectedGroup.title) persist(updateGroup(doc, selectedGroup.id, { title }));
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
            <label className="stack-field">
              绑定工作区
              <select value={selectedGroup.workspaceId ?? ""} onChange={(e) => persist(updateGroup(doc, selectedGroup.id, { workspaceId: e.target.value || null }))}>
                <option value="">不绑定</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-ghost small dim"
              onClick={() => {
                persist(deleteGroup(doc, selectedGroup.id));
                setSelection(null);
              }}
            >
              删除分组（保留卡片）
            </button>
          </div>
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
    </section>
  );
}
