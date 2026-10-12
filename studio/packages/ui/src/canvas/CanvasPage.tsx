import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { CanvasDoc, CanvasNode, Id, Point, Session, Task, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
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

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "node"; id: Id; sx: number; sy: number; ox: number; oy: number; moved: boolean };

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
  const [moving, setMoving] = useState<Record<Id, Point>>({});
  const [selected, setSelected] = useState<Id | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const placing = useRef(false);

  useEffect(() => saveView(view), [view]);

  // New tasks appear on the canvas automatically, ungrouped.
  useEffect(() => {
    if (!doc || placing.current) return;
    const next = placeMissing(doc, tasks);
    if (!next) return;
    placing.current = true;
    void save(next)
      .catch(() => undefined)
      .finally(() => {
        placing.current = false;
      });
  }, [doc, tasks, save]);

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
  });

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  }, []);

  const zoomCenter = (factor: number) => {
    const box = viewport.current?.getBoundingClientRect();
    zoomAt((box?.width ?? 800) / 2, (box?.height ?? 600) / 2, factor);
  };

  // Dragging: window listeners so the pointer can leave the card or the viewport.
  useEffect(() => {
    if (!drag || !doc) return;
    const onMove = (e: MouseEvent) => {
      if (drag.kind === "pan") {
        setView((v) => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }));
      } else {
        const dx = (e.clientX - drag.sx) / view.k;
        const dy = (e.clientY - drag.sy) / view.k;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        setMoving({ [drag.id]: { x: Math.round(drag.ox + dx), y: Math.round(drag.oy + dy) } });
      }
    };
    const onUp = () => {
      if (drag.kind === "node" && drag.moved) {
        const pos = moving[drag.id];
        if (pos) void save({ ...doc, nodes: doc.nodes.map((n) => (n.id === drag.id ? { ...n, pos } : n)) }).catch(() => undefined);
      }
      setDrag(null);
      setMoving({});
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, doc, moving, save, view.k]);

  const startPan = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    setSelected(null);
    setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
  };

  const startNode = (e: ReactMouseEvent, node: CanvasNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(node.id);
    setDrag({ kind: "node", id: node.id, sx: e.clientX, sy: e.clientY, ox: node.pos.x, oy: node.pos.y, moved: false });
  };

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const wsName = (id: Id) => workspaces.find((w) => w.id === id)?.name ?? "";

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
        <div
          className="canvas-world"
          data-testid="canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {doc?.nodes.map((node) => {
            const pos = moving[node.id] ?? node.pos;
            if (node.kind !== "task") return null;
            const task = taskById.get(node.taskId);
            if (!task) return null;
            const own = taskSessions(task, sessions);
            const status = taskStatus(own);
            const look = status ? SESSION_LOOK[status] : null;
            const live = own.filter((s) => !s.archivedAt).length;
            const where = task.scope.kind === "area" ? "跨工作区" : wsName(task.scope.workspaceId);
            return (
              <div
                key={node.id}
                className={selected === node.id ? "canvas-card selected" : "canvas-card"}
                style={{ left: pos.x, top: pos.y, width: CARD_W }}
                role="button"
                tabIndex={0}
                aria-label={task.title || "未命名任务"}
                data-testid="canvas-card"
                data-node-id={node.id}
                onMouseDown={(e) => startNode(e, node)}
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
        <div className="canvas-hint">拖空白处平移 · 滚轮缩放 · 拖卡片移动 · 双击打开任务</div>
      </div>
    </section>
  );
}
