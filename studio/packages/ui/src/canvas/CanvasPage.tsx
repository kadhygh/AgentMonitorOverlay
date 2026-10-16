import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { workspacesActivity, wouldCycle, type CanvasColor, type CanvasDoc, type CanvasGroup, type CanvasNode, type Id, type ModelProfile, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { CanvasSidebar, type CanvasSelection, type SidebarTab } from "./CanvasSidebar.js";
import { AgentTab } from "./AgentTab.js";
import { TodoTab } from "../planning/TodoTab.js";
import { useFeature } from "../lib/features.js";
import type { HostLink } from "../host/client.js";
import { addGroup, arrowBetween, contentBounds, deleteGroup, deleteGroupWithContents, duplicateNote, GROUP_HEADER, moveGroup, moveNode, outOfGroup, removeEdge, resizeGroup, reverseEdge, setColor, updateGroup } from "./geometry.js";
import { useCanvas } from "./useCanvas.js";
import { RefPicker, type RefChoice } from "./RefPicker.js";
import { CARD_H, CARD_W, cardHeight, NOTE_H, NOTE_W, NoteCard, RefCard, TaskCard } from "./cards.js";
import { CanvasMenu, item, SEP, type MenuEntry } from "./CanvasMenu.js";
import { DescriptionDialog } from "../task/DescriptionDialog.js";
import { DocsTab } from "./DocsTab.js";
import { PlanBanner, useTaskPlans } from "../taskplans/TaskPlans.js";

export { CARD_H, CARD_W, NOTE_H, NOTE_W } from "./cards.js";

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

type Menu = { x: number; y: number; label: string; entries: MenuEntry[] };

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
  // Right-click (stage 16): the menu open now; 连依赖 waiting for its second card; the description being written.
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linkFrom, setLinkFrom] = useState<Id | null>(null);
  const [describing, setDescribing] = useState<Id | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const plans = useTaskPlans(link).filter((p) => p.topicId === topic.id);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => saveView(view), [view]);

  const persist = useCallback((next: CanvasDoc) => void save(next).catch(() => undefined), [save]);
  const latestDoc = useRef(doc);
  latestDoc.current = doc;
  const edit = useCallback(
    (apply: (d: CanvasDoc) => CanvasDoc) => {
      const cur = latestDoc.current;
      if (!cur) return;
      const next = apply(cur);
      if (next !== cur) persist(next);
    },
    [persist],
  );

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const anyTaskById = new Map(allTasks.map((t) => [t.id, t]));
  const nodeSize = (n: CanvasNode) => (n.kind === "note" ? { w: NOTE_W, h: NOTE_H } : { w: CARD_W, h: cardHeight(anyTaskById.get(n.taskId)) });

  // Delete / Backspace removes the selected group (its cards stay), note or reference card (never the task itself),
  // unless typing somewhere. Escape leaves 连依赖.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && linkFrom) {
        setLinkFrom(null);
        return;
      }
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
  }, [doc, selection, persist, linkFrom]);

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

  /** 全部显示: everything on the canvas in view (at most 100%). */
  const fitAll = () => {
    const b = doc && contentBounds(doc, nodeSize);
    const box = viewport.current?.getBoundingClientRect();
    if (!b || !box) return setView({ x: 0, y: 0, k: 1 });
    const k = Math.min(1, MAX_K, Math.max(MIN_K, Math.min((box.width - 80) / b.w, (box.height - 80) / b.h)));
    setView({ k, x: (box.width - b.w * k) / 2 - b.x * k, y: (box.height - b.h * k) / 2 - b.y * k });
  };

  /** A rect in the middle of the view, at the current zoom. */
  const centreOf = (r: { x: number; y: number; w: number; h: number }) => {
    const box = viewport.current?.getBoundingClientRect();
    setView((v) => ({ ...v, x: (box?.width ?? 800) / 2 - (r.x + r.w / 2) * v.k, y: (box?.height ?? 600) / 2 - (r.y + r.h / 2) * v.k }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeSize follows the tasks, which do not change mid-drag
  }, [drag, persist, view.k]);

  const shown = preview ?? doc;

  // preventDefault on every drag start: a leftover text selection would otherwise turn the gesture into a native
  // drag-and-drop, which swallows the mousemove/mouseup events the canvas listens to.
  const startPan = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setSelection(null);
    setPicking(false);
    setLinkFrom(null);
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

  /** A point of the canvas (world coordinates) under the pointer, or the middle of the view. */
  const worldAt = (clientX?: number, clientY?: number) => {
    const box = viewport.current?.getBoundingClientRect();
    const px = clientX !== undefined && box ? clientX - box.left : (box?.width ?? 800) / 2;
    const py = clientY !== undefined && box ? clientY - box.top : (box?.height ?? 600) / 2;
    return { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
  };

  /** New group, in the middle of the view or where the menu was opened. */
  const newGroup = (at = worldAt()) => {
    if (!doc) return;
    const group: CanvasGroup = { id: newCanvasId("g"), title: "新分组", workspaceId: null, rect: { x: Math.round(at.x - 210), y: Math.round(at.y - 150), w: 420, h: 300 } };
    persist(addGroup(doc, group));
    setSelection({ kind: "group", id: group.id });
  };

  /** New note, in the middle of the view or where the menu was opened. */
  const newNote = (at = worldAt()) => {
    if (!doc) return;
    const x = Math.round(at.x - NOTE_W / 2);
    const y = Math.round(at.y - NOTE_H / 2);
    const id = newCanvasId("n");
    persist(moveNode({ ...doc, nodes: [...doc.nodes, { id, kind: "note", text: "", groupId: null, pos: { x, y } }] }, id, { x, y }, { w: NOTE_W, h: NOTE_H }));
    setSelection({ kind: "node", id });
    editNote();
  };

  /** The note's text is written in the sidebar. */
  const editNote = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.canvas-side textarea[aria-label="便签内容"]')?.focus());

  /**
   * "引用任务": a reference card for another topic's task, or this topic's own task placed as its card, in the middle of
   * the visible area (moved down while it would cover another card; inside a group if it lands in one).
   */
  const addPicked = (choice: RefChoice) => {
    if (!doc) return;
    const mid = worldAt();
    const x = Math.round(mid.x - CARD_W / 2);
    let y = Math.round(mid.y - CARD_H / 2);
    for (let i = 0; i < 40 && doc.nodes.some((n) => Math.abs(n.pos.x - x) < CARD_W && Math.abs(n.pos.y - y) < CARD_H); i++) y += CARD_H + 12;
    const id = newCanvasId("n");
    const node: CanvasNode = { id, kind: choice.kind === "ref" ? "ref" : "task", taskId: choice.taskId, groupId: null, pos: { x, y } };
    persist(moveNode({ ...doc, nodes: [...doc.nodes, node] }, id, { x, y }, nodeSize(node)));
    setPicking(false);
    setSelection({ kind: "node", id });
  };

  /** 连依赖: the task picked second waits for the first. */
  const link2 = (toTaskId: Id) => {
    const from = linkFrom;
    setLinkFrom(null);
    if (!doc || !from || from === toTaskId) return;
    if (doc.edges.some((e) => e.from === from && e.to === toTaskId) || wouldCycle(doc.edges, from, toTaskId)) return;
    persist({ ...doc, edges: [...doc.edges, { id: newCanvasId("e"), kind: "depends", from, to: toTaskId }] });
  };

  const openMenu = (e: ReactMouseEvent, label: string, entries: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setPicking(false);
    setMenu({ x: e.clientX, y: e.clientY, label, entries });
  };
  const colorOf = (target: { kind: "group" | "node"; id: Id }, value: CanvasColor | undefined): MenuEntry => ({ kind: "colors", value, onPick: (c) => edit((d) => setColor(d, target, c)) });
  const groupItems = (node: CanvasNode): MenuEntry[] => (node.groupId ? [item("移出分组", () => edit((d) => outOfGroup(d, node.id, nodeSize(node))))] : []);
  const centreItem = (node: CanvasNode) => item("居中显示", () => centreOf({ ...node.pos, ...nodeSize(node) }));

  // ---- the menus --------------------------------------------------------------------------------------------------

  const canvasMenu = (e: ReactMouseEvent) => {
    if (!doc) return;
    const at = worldAt(e.clientX, e.clientY);
    openMenu(e, "画布", [
      item("新便签", () => newNote(at), { testId: "menu-new-note" }),
      item("新分组", () => newGroup(at), { testId: "menu-new-group" }),
      item("引用任务…", () => setPicking(true)),
      ...(onNewTask ? [item("在专题里新建任务", onNewTask)] : []),
      SEP,
      item("全部显示", fitAll, { testId: "menu-fit" }),
      item("复位缩放", () => setView({ x: 0, y: 0, k: 1 })),
    ]);
  };

  const taskMenu = (e: ReactMouseEvent, node: CanvasNode, task: Task) => {
    setSelection({ kind: "node", id: node.id });
    openMenu(e, "任务卡片", [
      colorOf({ kind: "node", id: node.id }, node.color),
      item(task.description ? "编辑说明…" : "添加说明…", () => setDescribing(task.id), { testId: "menu-describe" }),
      item("打开任务", () => onOpenTask(task.id)),
      item("连依赖：选它之后的任务…", () => setLinkFrom(task.id), { hint: "再点一张任务卡片：那个任务要等这个做完才开始", testId: "menu-link" }),
      ...groupItems(node),
      centreItem(node),
      SEP,
      item("从画布上拿掉（任务不变）", () => edit((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id) })), { danger: true, hint: "只拿掉卡片：任务仍在专题里，依赖也保留" }),
    ]);
  };

  const refMenu = (e: ReactMouseEvent, node: CanvasNode, target: Task | undefined) => {
    setSelection({ kind: "node", id: node.id });
    const live = target && !target.archivedAt;
    openMenu(e, "引用卡片", [
      colorOf({ kind: "node", id: node.id }, node.color),
      ...(live ? [item(target.description ? "编辑说明…" : "添加说明…", () => setDescribing(target.id)), item("打开任务", () => onOpenTask(target.id))] : []),
      ...groupItems(node),
      centreItem(node),
      SEP,
      item("删除引用卡片", () => edit((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id) })), { danger: true, hint: "任务不受影响" }),
    ]);
  };

  const noteMenu = (e: ReactMouseEvent, node: CanvasNode) => {
    setSelection({ kind: "node", id: node.id });
    openMenu(e, "便签", [
      colorOf({ kind: "node", id: node.id }, node.color),
      item("编辑", editNote),
      item("复制一份", () => edit((d) => duplicateNote(d, node.id, newCanvasId("n")))),
      ...groupItems(node),
      SEP,
      item("删除便签", () => edit((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id) })), { danger: true }),
    ]);
  };

  const groupMenu = (e: ReactMouseEvent, g: CanvasGroup) => {
    setSelection({ kind: "group", id: g.id });
    openMenu(e, "分组", [
      colorOf({ kind: "group", id: g.id }, g.color),
      item("改名", () => setRenaming(g.id)),
      item("居中显示", () => centreOf(g.rect)),
      SEP,
      item("解散分组（保留卡片）", () => edit((d) => deleteGroup(d, g.id))),
      item("删除分组和里面的便签、引用", () => edit((d) => deleteGroupWithContents(d, g.id)), { danger: true, hint: "任务卡片留在画布上，任务不受影响" }),
    ]);
  };

  const edgeMenu = (e: ReactMouseEvent, edgeId: Id, from: Id, to: Id) => {
    const others = (doc?.edges ?? []).filter((x) => x.id !== edgeId);
    openMenu(e, "依赖", [
      item("反过来", () => edit((d) => reverseEdge(d, edgeId)), { disabled: wouldCycle(others, to, from), hint: `改成「${anyTaskById.get(to)?.title || "任务"}」先做` }),
      item("删除依赖", () => edit((d) => removeEdge(d, edgeId)), { danger: true }),
    ]);
  };

  const wsName = (id: Id | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "") : "");
  // Whether each bound project is free (design/scheduler.md): the scheduler only proposes work for free ones.
  const activity = workspacesActivity(workspaces, sessions);
  const cardOf = new Map(
    (shown?.nodes ?? []).filter((n) => n.kind === "task").map((n) => [(n as { taskId: Id }).taskId, { x: n.pos.x, y: n.pos.y, w: CARD_W, h: cardHeight(taskById.get((n as { taskId: Id }).taskId)) }]),
  );
  const describedTask = describing ? anyTaskById.get(describing) : undefined;

  return (
    <section className="canvas-page" aria-label="画布">
      <div className="toaster">
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
      </div>
      <div className="canvas-row">
      <div className={drag?.kind === "pan" ? "canvas-viewport panning" : "canvas-viewport"} ref={viewport} onMouseDown={startPan} onContextMenu={canvasMenu} data-testid="canvas-viewport" data-linking={linkFrom ? "true" : undefined}>
        <div className="canvas-world" data-testid="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {shown?.groups.map((g) => (
            <div
              key={g.id}
              className={selection?.kind === "group" && selection.id === g.id ? "canvas-group selected" : "canvas-group"}
              style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}
              data-testid="canvas-group"
              data-group-id={g.id}
              data-color={g.color}
              onContextMenu={(e) => groupMenu(e, g)}
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
              return (
                <g key={e.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="canvas-edge" markerEnd="url(#amo-arrow)" data-testid="canvas-edge" />
                  {/* A wider, invisible line takes the right-click. */}
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="canvas-edge-hit" data-testid="canvas-edge-hit" onMouseDown={(ev) => ev.stopPropagation()} onContextMenu={(ev) => edgeMenu(ev, e.id, e.from, e.to)} />
                </g>
              );
            })}
          </svg>
          {shown?.nodes.map((node) => {
            const selected = selection?.kind === "node" && selection.id === node.id;
            if (node.kind === "note") {
              return <NoteCard key={node.id} node={node} selected={selected} onMouseDown={(e) => startDrag(e, "node", node.id)} onContextMenu={(e) => noteMenu(e, node)} onEdit={editNote} />;
            }
            if (node.kind === "ref") {
              const target = anyTaskById.get(node.taskId);
              return (
                <RefCard
                  key={node.id}
                  node={node}
                  target={target}
                  topics={topics}
                  sessions={sessions}
                  workspaces={workspaces}
                  selected={selected}
                  onOpen={() => target && onOpenTask(target.id)}
                  onMouseDown={(e) => startDrag(e, "node", node.id)}
                  onContextMenu={(e) => refMenu(e, node, target)}
                />
              );
            }
            const task = taskById.get(node.taskId);
            if (!task) return null;
            return (
              <TaskCard
                key={node.id}
                node={node}
                task={task}
                sessions={sessions}
                workspaces={workspaces}
                selected={selected}
                linking={!!linkFrom && linkFrom !== task.id}
                onOpen={() => onOpenTask(task.id)}
                onMouseDown={(e) => {
                  if (linkFrom && e.button === 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    return link2(task.id);
                  }
                  startDrag(e, "node", node.id);
                }}
                onContextMenu={(e) => taskMenu(e, node, task)}
              />
            );
          })}
        </div>

        <div className="canvas-tools" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          {onNewTask && (
            <button type="button" className="btn-primary small" onClick={onNewTask}>
              + 在专题里新建任务
            </button>
          )}
          <button type="button" className="btn-ghost small" onClick={() => newGroup()} disabled={!doc}>
            + 分组
          </button>
          <button type="button" className="btn-ghost small" onClick={() => setPicking((v) => !v)} disabled={!doc} aria-expanded={picking}>
            引用任务
          </button>
          <button type="button" className="btn-ghost small" onClick={() => newNote()} disabled={!doc}>
            + 便签
          </button>
        </div>

        <PlanBanner link={link} plans={plans} tasks={allTasks} workspaces={workspaces} profiles={profiles} />

        {linkFrom && (
          <div className="canvas-linking" role="status" data-testid="canvas-linking" onMouseDown={(e) => e.stopPropagation()}>
            点另一张任务卡片：它要等「{anyTaskById.get(linkFrom)?.title || "这个任务"}」做完才开始
            <button type="button" className="link-btn" onClick={() => setLinkFrom(null)}>
              取消（Esc）
            </button>
          </div>
        )}

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

        <div className="canvas-zoom" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <button type="button" aria-label="缩小" onClick={() => zoomCenter(1 / 1.2)}>
            −
          </button>
          <span data-testid="zoom-label">{Math.round(view.k * 100)}%</span>
          <button type="button" aria-label="放大" onClick={() => zoomCenter(1.2)}>
            +
          </button>
          <button type="button" className="canvas-reset" onClick={fitAll} title="把画布上的内容都放进视野">
            全部
          </button>
          <button type="button" className="canvas-reset" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
            复位
          </button>
        </div>
        <div className="canvas-hint">拖空白处平移 · 滚轮缩放 · 右键看更多操作 · 双击打开任务</div>
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
          onEdit={edit}
          onClearSelection={() => setSelectionState(null)}
          onOpenTask={onOpenTask}
          onDescribe={(taskId) => setDescribing(taskId)}
          newId={newCanvasId}
          todoTab={planning ? <TodoTab link={link} workspaces={workspaces} profiles={profiles} onOpenTask={onOpenTask} activity={activity} topicId={topic.id} /> : undefined}
          agentTab={<AgentTab link={link} topicId={topic.id} />}
          docsTab={<DocsTab link={link} topicId={topic.id} readOnly={!!topic.archivedAt} />}
        />
      )}
      </div>
      {menu && <CanvasMenu x={menu.x} y={menu.y} label={menu.label} entries={menu.entries} onClose={closeMenu} />}
      {describedTask && <DescriptionDialog link={link} task={describedTask} onClose={() => setDescribing(null)} />}
    </section>
  );
}
