import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CANVAS_LINK_LABEL_MAX, CANVAS_SIDES, ITEM_CARD, REVIEW_STATUSES, workspacesActivity, wouldCycle, type CanvasCallout, type CanvasColor, type CanvasDoc, type CanvasGroup, type CanvasItem, type CanvasLink, type CanvasNode, type CanvasSide, type Id, type Point, type ModelProfile, type ReviewStatus, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError } from "../host/client.js";
import { useCallouts } from "./useCallouts.js";
import { CalloutDialog, CalloutLayer, calloutFlags, ItemCard, ItemDetail, itemActivity, ITEM_MIN, TalkTab } from "./review.js";
import { CanvasSidebar, sidebarTabs, type SidebarTab } from "./CanvasSidebar.js";
import { CanvasDetail, type CanvasSelection } from "./CanvasDetail.js";
import { useDragWidth } from "../lib/dragWidth.js";
import { AgentTab } from "./AgentTab.js";
import { TodoTab } from "../planning/TodoTab.js";
import { useFeature } from "../lib/features.js";
import type { HostLink } from "../host/client.js";
import { addGroup, addLink, arrowBetween, contentBounds, deleteGroup, deleteGroupAndCards, duplicateNote, gridStyle, GROUP_HEADER, groupContents, linkCurve, moveGroup, moveNode, nearestSide, outOfGroup, removeEdge, removeLink, resizeGroup, resizeNode, reverseEdge, reverseLink, setColor, setLinkLabel, sidePoint, updateGroup } from "./geometry.js";
import { useCanvas } from "./useCanvas.js";
import { RefPicker, type RefChoice } from "./RefPicker.js";
import { CARD_H, CARD_MIN, CARD_W, cardHeight, NOTE_H, NOTE_MIN, NOTE_W, NoteCard, RefCard, TaskCard } from "./cards.js";
import { DeleteGroupDialog } from "./DeleteGroupDialog.js";
import { CanvasMenu, item, SEP, type MenuEntry } from "./CanvasMenu.js";
import { DescriptionDialog } from "../task/DescriptionDialog.js";
import { DocsTab } from "./DocsTab.js";
import { TopicBookmarks } from "../marks/MarksApp.js";
import { PlanBanner, useTaskPlans } from "../taskplans/TaskPlans.js";

export { CARD_H, CARD_W, NOTE_H, NOTE_W } from "./cards.js";

const MIN_K = 0.3;
const MAX_K = 2.5;
const VIEW_KEY = "amo.canvasView";
/** The 画布小窗 keeps its own zoom and place. */
const MINI_VIEW_KEY = "amo.canvasMiniView";
/**
 * The sidebar (2026-10-29, the user: a switch like the task page's, and a width to drag): shown unless put away with
 * 侧栏 (it always showed before), its width and last tab, all kept on this machine.
 */
const SIDE_KEY = "amo.canvasSidebar";
const SIDE_W_KEY = "amo.canvasSidebarWidth";
const SIDE_TAB_KEY = "amo.canvasSideTab";
export const SIDE_W = { def: 320, min: 260, max: 560 };

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-window convenience only
  }
}

interface View {
  x: number;
  y: number;
  k: number;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "node"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean }
  | { kind: "group-move"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean }
  | { kind: "group-resize"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean }
  /** A card's bottom-right corner (2026-10-29), from the size it had when the drag began. */
  | { kind: "node-resize"; id: Id; sx: number; sy: number; base: CanvasDoc; moved: boolean; w: number; h: number }
  /** 连线 being drawn from a card's side handle (2026-10-19). */
  | { kind: "connect"; from: Id; side: CanvasSide };

type Menu = { x: number; y: number; label: string; entries: MenuEntry[] };

function loadView(key: string): View {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "") as View;
    if ([v.x, v.y, v.k].every(Number.isFinite)) return v;
  } catch {
    // per-viewer convenience only
  }
  return { x: 0, y: 0, k: 1 };
}

function saveView(key: string, v: View) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
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
  /** A question to open once the canvas has it (from Focus); `nav` changes with each ask. */
  openCallout?: { id: Id; nav: number };
  /**
   * 画布小窗 (2026-10-27): the canvas alone, no sidebar or editing tools — the cards, their bubbles and the question
   * window — fitted into view when it opens.
   */
  compact?: boolean;
}

export function CanvasPage({ link, topic, tasks, allTasks = tasks, topics = [topic], sessions, workspaces, profiles = [], onOpenTask, onNewTask, openCallout, compact = false }: CanvasPageProps) {
  const { doc, save, conflict, dismissConflict, error, dismissError } = useCanvas(link, topic.id);
  const viewKey = compact ? MINI_VIEW_KEY : VIEW_KEY;
  const [view, setView] = useState<View>(() => loadView(viewKey));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreviewState] = useState<CanvasDoc | null>(null);
  const previewRef = useRef<CanvasDoc | null>(null);
  const setPreview = (next: CanvasDoc | null) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  const [selection, setSelectionState] = useState<CanvasSelection>(null);
  // Selecting opens the 详情框 beside the card; the sidebar keeps its tab (2026-10-29: 详情 left the sidebar).
  const setSelection = setSelectionState;
  const planning = useFeature("planning");
  const [sideOpen, setSideOpenState] = useState(() => readKey(SIDE_KEY) !== "0");
  const setSideOpen = (on: boolean) => {
    setSideOpenState(on);
    writeKey(SIDE_KEY, on ? "1" : "0");
  };
  const sideW = useDragWidth(SIDE_W_KEY, SIDE_W.def, SIDE_W.min, SIDE_W.max, true);
  const [tabState, setTabState] = useState(() => readKey(SIDE_TAB_KEY) as SidebarTab | null);
  const tabIds = sidebarTabs({ todoTab: planning, talkTab: true, docsTab: true, marksTab: true }).map(([id]) => id);
  const tab: SidebarTab = tabState && tabIds.includes(tabState) ? tabState : tabIds[0]!;
  const setTab = (next: SidebarTab) => {
    setTabState(next);
    writeKey(SIDE_TAB_KEY, next);
  };
  /** A tab of the sidebar, brought out if it was put away. */
  const showTab = (next: SidebarTab) => {
    setTab(next);
    if (!sideOpen) setSideOpen(true);
  };
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [picking, setPicking] = useState(false);
  // Right-click (stage 16): the menu open now; 连依赖 waiting for its second card; the description being written.
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linkFrom, setLinkFrom] = useState<Id | null>(null);
  const [describing, setDescribing] = useState<Id | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const plans = useTaskPlans(link).filter((p) => p.topicId === topic.id);
  // 画布审阅 (2026-10-27): the bubbles on the cards, the one open in its window, and a short notice (opening a session…).
  const callouts = useCallouts(link, topic.id);
  const [openedCallout, setOpenCallout] = useState<Id | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  // 连线 (2026-10-19): the line being drawn (its loose end follows the pointer), and the line whose label is edited.
  const [drawing, setDrawing] = useState<{ from: Id; side: CanvasSide; at: Point } | null>(null);
  const [editingLink, setEditingLink] = useState<Id | null>(null);
  const cancelLabel = useRef(false);
  // Cards as drawn (a note grows with its text): lines meet their real sides.
  const [sizes, setSizes] = useState<ReadonlyMap<Id, { w: number; h: number }>>(new Map());
  useLayoutEffect(() => {
    const el = world.current;
    if (!el) return;
    let next: Map<Id, { w: number; h: number }> | null = null;
    for (const card of el.querySelectorAll<HTMLElement>("[data-node-id]")) {
      const id = card.dataset.nodeId!;
      const size = { w: card.offsetWidth, h: card.offsetHeight };
      const old = (next ?? sizes).get(id);
      if (!old || old.w !== size.w || old.h !== size.h) (next ??= new Map(sizes)).set(id, size);
    }
    if (next) setSizes(next);
  });

  useEffect(() => saveView(viewKey, view), [view, viewKey]);

  // The viewport's size, for the 详情框 to stay inside it (the sidebar's width and the window change it).
  const [area, setArea] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setArea((a) => (a.w === el.clientWidth && a.h === el.clientHeight ? a : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  // The topic's archived tasks keep their cards, greyed (2026-10-22); a task that left the topic does not.
  const cardTaskById = new Map([...allTasks.filter((t) => t.archivedAt && t.topicId === topic.id), ...tasks].map((t) => [t.id, t]));
  const anyTaskById = new Map(allTasks.map((t) => [t.id, t]));
  const nodeSize = (n: CanvasNode) => n.size ?? (n.kind === "note" ? { w: NOTE_W, h: NOTE_H } : n.kind === "item" ? ITEM_CARD : { w: CARD_W, h: cardHeight(anyTaskById.get(n.taskId)) });
  const minSize = (n: CanvasNode) => (n.kind === "note" ? NOTE_MIN : n.kind === "item" ? ITEM_MIN : CARD_MIN);

  // 删除分组 (2026-10-29): a group with cards asks first whether they go too; an empty one goes at once.
  const [deletingGroup, setDeletingGroup] = useState<Id | null>(null);
  const askDeleteGroup = (groupId: Id) => {
    const cur = latestDoc.current;
    if (!cur) return;
    if (groupContents(cur, groupId).total > 0) return setDeletingGroup(groupId);
    persist(deleteGroup(cur, groupId));
    setSelectionState((s) => (s?.kind === "group" && s.id === groupId ? null : s));
  };
  // The group went meanwhile (deleted elsewhere): nothing left to ask about.
  useEffect(() => {
    if (deletingGroup && doc && !doc.groups.some((g) => g.id === deletingGroup)) setDeletingGroup(null);
  }, [deletingGroup, doc]);

  // Delete / Backspace removes the selected group (asking about its cards), note or reference card (never the task
  // itself), unless typing somewhere. Escape leaves 连依赖, else closes the 详情框 (2026-10-29): a field in the box being
  // typed in is left first (its text kept), and an Esc meant for a dialog, a menu or a field elsewhere is not ours.
  const overlayOpen = !!(menu || describing || deletingGroup || openedCallout || picking || editingLink || renaming);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "Escape" && linkFrom) {
        setLinkFrom(null);
        return;
      }
      if (e.key === "Escape") {
        if (!selection || overlayOpen || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
        if (typing) {
          if (!t!.closest(".canvas-detail")) return;
          e.preventDefault();
          t!.blur();
          return;
        }
        e.preventDefault();
        setSelectionState(null);
        return;
      }
      if ((e.key !== "Delete" && e.key !== "Backspace") || !doc || !selection || deletingGroup) return;
      if (typing) return;
      if (selection.kind === "group") {
        e.preventDefault();
        askDeleteGroup(selection.id);
      } else if (doc.nodes.some((n) => n.id === selection.id && (n.kind === "note" || n.kind === "ref" || n.kind === "item"))) {
        e.preventDefault();
        persist({ ...doc, nodes: doc.nodes.filter((n) => n.id !== selection.id) });
        setSelectionState(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- askDeleteGroup reads the latest document itself
  }, [doc, selection, persist, linkFrom, deletingGroup, overlayOpen]);

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
      if ((e.target as HTMLElement | null)?.closest?.(".ref-picker, .canvas-detail")) return; // the task list and the 详情框 scroll
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
    const cards = doc && contentBounds(doc, nodeSize);
    const box = viewport.current?.getBoundingClientRect();
    if (!cards || !box) return setView({ x: 0, y: 0, k: 1 });
    // Bubbles stand above their cards' top-right corners: room for them too (画布审阅).
    const out = callouts.some((c) => c.state !== "closed");
    const b = out ? { x: cards.x, y: cards.y - 70, w: cards.w + 240, h: cards.h + 70 } : cards;
    const k = Math.min(1, MAX_K, Math.max(MIN_K, Math.min((box.width - 80) / b.w, (box.height - 80) / b.h)));
    setView({ k, x: (box.width - b.w * k) / 2 - b.x * k, y: (box.height - b.h * k) / 2 - b.y * k });
  };

  // The small window shows the whole canvas when it opens (and when it switches topic: the page is made anew).
  // Again once when its bubbles first arrive (they load after the document), to make room for them.
  const fitted = useRef({ doc: false, bubbles: false });
  const anyOut = callouts.some((c) => c.state !== "closed");
  useEffect(() => {
    if (!compact || !doc) return;
    const f = fitted.current;
    if (f.doc && (f.bubbles || !anyOut)) return;
    f.doc = true;
    if (anyOut) f.bubbles = true;
    requestAnimationFrame(fitAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the document, then its bubbles, first arrive
  }, [compact, doc !== null, anyOut]);

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
      if (drag.kind === "connect") {
        setDrawing({ from: drag.from, side: drag.side, at: worldAt(e.clientX, e.clientY) });
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
      } else if (drag.kind === "node-resize") {
        // The card stays where it is (and in its group); only its size follows the corner, down to its kind's least.
        const min = minSize(drag.base.nodes.find((n) => n.id === drag.id)!);
        setPreview(resizeNode(drag.base, drag.id, { w: Math.max(min.w, drag.w + dx), h: Math.max(min.h, drag.h + dy) }));
      } else {
        const g = drag.base.groups.find((x) => x.id === drag.id)!;
        setPreview(resizeGroup(drag.base, drag.id, g.rect.w + dx, g.rect.h + dy));
      }
    };
    const onUp = (e: MouseEvent) => {
      if (drag.kind === "connect") {
        // Let go on another card: on one of its handles, that side; elsewhere on it, the side nearest the pointer.
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const to = hit?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
        const target = to && to !== drag.from ? latestDoc.current?.nodes.find((n) => n.id === to) : undefined;
        if (target) {
          const side = hit?.closest<HTMLElement>(".canvas-handle")?.dataset.side as CanvasSide | undefined;
          const toSide = side && CANVAS_SIDES.includes(side) ? side : nearestSide(rectOf(target), worldAt(e.clientX, e.clientY));
          edit((d) => addLink(d, { id: newCanvasId("l"), from: drag.from, fromSide: drag.side, to: target.id, toSide }));
        }
        setDrawing(null);
        setDrag(null);
        return;
      }
      if (drag.kind === "pan" && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) setSelectionState(null);
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
  const nodeById = new Map((shown?.nodes ?? []).map((n) => [n.id, n]));
  /** A card's box as drawn. */
  const rectOf = (n: CanvasNode) => ({ ...n.pos, ...(sizes.get(n.id) ?? nodeSize(n)) });

  /** 连线: a drag from one of a card's four side handles draws a line to another card. */
  const startConnect = (e: ReactMouseEvent, nodeId: Id, side: CanvasSide) => {
    if (e.button !== 0 || !doc) return;
    e.preventDefault();
    e.stopPropagation();
    setLinkFrom(null);
    setDrag({ kind: "connect", from: nodeId, side });
    setDrawing({ from: nodeId, side, at: worldAt(e.clientX, e.clientY) });
  };
  /**
   * A card's size (2026-10-29): dragged from its bottom-right corner (the four side handles draw lines, so the corner is
   * free), kept once let go; a double-click there gives the card back its own size.
   */
  const startResize = (e: ReactMouseEvent, nodeId: Id) => {
    if (e.button !== 0 || !doc) return;
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur?.();
    setLinkFrom(null);
    setSelection({ kind: "node", id: nodeId });
    const { w, h } = rectOf(node);
    setDrag({ kind: "node-resize", id: nodeId, sx: e.clientX, sy: e.clientY, base: doc, moved: false, w, h });
  };
  const handlesOf = (nodeId: Id) => (
    <>
      {CANVAS_SIDES.map((side) => (
        <span key={side} className="canvas-handle" data-side={side} title="拖到另一张卡片上，连一条线" onMouseDown={(e) => startConnect(e, nodeId, side)} onDoubleClick={(e) => e.stopPropagation()} data-testid="canvas-handle" />
      ))}
      <span
        className="canvas-card-resize"
        aria-label="调整卡片大小"
        title="拖动调整卡片大小；双击恢复原来的大小"
        onMouseDown={(e) => startResize(e, nodeId)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          edit((d) => (d.nodes.find((n) => n.id === nodeId)?.size ? resizeNode(d, nodeId, null) : d));
        }}
        data-testid="canvas-card-resize"
      />
    </>
  );
  const saveLabel = (linkId: Id, text: string) => {
    setEditingLink(null);
    if (cancelLabel.current) {
      cancelLabel.current = false;
      return;
    }
    edit((d) => setLinkLabel(d, linkId, text));
  };

  // preventDefault on every drag start: a leftover text selection would otherwise turn the gesture into a native
  // drag-and-drop, which swallows the mousemove/mouseup events the canvas listens to.
  // A click on the empty canvas lets go of the selection (and closes its 详情框); a drag there only pans, the box
  // following its card (2026-10-29). A field in the box being typed in is left first, so its text is kept.
  const startPan = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
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

  /** The note's text is written in its 详情框 (once the box has found its place beside the note). */
  const editNote = () => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.canvas-detail textarea[aria-label="便签内容"]')?.focus()));

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

  // ---- 画布审阅 ---------------------------------------------------------------------------------------------------

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const items = (shown?.nodes ?? []).filter((n): n is CanvasItem => n.kind === "item");
  const flags = calloutFlags(callouts);
  const openQuestions = callouts.filter((c) => c.kind === "question" && c.state === "open");
  const nodeOfTarget = (target: Id) => shown?.nodes.find((n) => n.id === target || (n.kind === "task" && n.taskId === target));
  /** A bubble's card (or its group's title bar). */
  const anchorOf = (target: Id) => {
    const n = nodeOfTarget(target);
    if (n) return rectOf(n);
    const g = shown?.groups.find((x) => x.id === target);
    return g ? { ...g.rect, h: GROUP_HEADER } : null;
  };
  const targetName = (target: Id) => {
    const n = nodeOfTarget(target);
    if (n?.kind === "item") return `#${n.num} ${n.title}`;
    if (n?.kind === "note") return `便签「${n.text.replace(/\s+/g, " ").trim().slice(0, 24)}」`;
    if (n?.kind === "task" || n?.kind === "ref") return `任务「${anyTaskById.get(n.taskId)?.title || "未命名任务"}」`;
    const g = shown?.groups.find((x) => x.id === target);
    return g ? `分组「${g.title}」` : "卡片已不在画布上";
  };
  const failed = (what: string) => (err: unknown) => setNotice({ text: `${what}：${err instanceof HostApiError ? err.message : String(err)}`, error: true });
  /** Centres a bubble's card; one still out opens in its window. */
  const focusCallout = (c: CanvasCallout) => {
    const r = anchorOf(c.target);
    if (r) centreOf(r);
    if (c.state !== "closed") setOpenCallout(c.id);
  };
  const closeCallout = (c: CanvasCallout) => void call(link, "POST /api/callouts/:id/close", { id: c.id }).catch(failed("没能收起"));
  const openSession = (sessionId: Id) => {
    const s = sessionById.get(sessionId);
    if (s?.taskId) onOpenTask(s.taskId, s.id);
    else setNotice({ text: "这个会话不在任何任务里，任务页打不开它", error: true });
  };
  const setItemStatus = (id: Id, status: ReviewStatus) => edit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id && n.kind === "item" ? { ...n, status } : n)) }));
  /** An item goes with the bubbles still out on it. */
  const deleteItem = (id: Id) => {
    edit((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id) }));
    for (const c of callouts) if (c.target === id && c.state !== "closed") closeCallout(c);
    if (selection?.kind === "node" && selection.id === id) setSelectionState(null);
  };
  /** 就这条展开聊: a new session on this item, opened at once. */
  const discuss = (it: CanvasItem) => {
    setNotice({ text: `正在为 #${it.num} 开会话…` });
    call(link, "POST /api/topics/:id/canvas/items/:itemId/discuss", { id: topic.id, itemId: it.id }, {})
      .then((s) => {
        setNotice(null);
        if (s.taskId) onOpenTask(s.taskId, s.id);
      })
      .catch(failed("没能开会话"));
  };
  const shownCallout = openedCallout ? callouts.find((c) => c.id === openedCallout && c.state !== "closed") : undefined;
  // Asked from outside (Focus): once the canvas and its bubbles are here, centre that question and open it.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!openCallout || !doc) return;
    const key = `${openCallout.id}:${openCallout.nav}`;
    const c = callouts.find((x) => x.id === openCallout.id);
    if (asked.current === key || !c) return;
    asked.current = key;
    focusCallout(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask, when its bubble is known
  }, [openCallout?.id, openCallout?.nav, doc !== null, callouts]);

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
    if (task.archivedAt) {
      // Archived: read-only, so no description or new dependencies; the card can still be moved, grouped or taken off.
      return openMenu(e, "已归档的任务卡片", [
        colorOf({ kind: "node", id: node.id }, node.color),
        item("打开任务（只读）", () => onOpenTask(task.id)),
        ...groupItems(node),
        centreItem(node),
        SEP,
        item("从画布上拿掉", () => edit((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id) })), { danger: true, hint: "只拿掉卡片：任务仍是归档状态" }),
      ]);
    }
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

  const itemMenu = (e: ReactMouseEvent, node: CanvasItem) => {
    setSelection({ kind: "node", id: node.id });
    const poster = node.sessionId ? sessionById.get(node.sessionId) : undefined;
    openMenu(e, `审阅条目 #${node.num}`, [
      ...REVIEW_STATUSES.map((s) => item(`${node.status === s.id ? "✓ " : ""}标为${s.label}`, () => setItemStatus(node.id, s.id), { disabled: node.status === s.id, testId: `menu-item-${s.id}` })),
      SEP,
      item("就这条展开聊（新会话）", () => discuss(node), { hint: "在铺这份审阅的任务里开一个会话，先读这一条", testId: "menu-item-thread" }),
      ...(poster?.taskId ? [item("打开铺它的会话", () => openSession(poster.id))] : []),
      colorOf({ kind: "node", id: node.id }, node.color),
      ...groupItems(node),
      centreItem(node),
      SEP,
      item("删除条目", () => deleteItem(node.id), { danger: true }),
    ]);
  };

  const groupMenu = (e: ReactMouseEvent, g: CanvasGroup) => {
    setSelection({ kind: "group", id: g.id });
    openMenu(e, "分组", [
      colorOf({ kind: "group", id: g.id }, g.color),
      item("改名", () => setRenaming(g.id)),
      item("居中显示", () => centreOf(g.rect)),
      SEP,
      item("删除分组…", () => askDeleteGroup(g.id), { danger: true, hint: "可以选卡片留在原处，还是一起删（任务卡片只从画布上拿掉，任务不删）", testId: "menu-delete-group" }),
    ]);
  };

  const linkMenu = (e: ReactMouseEvent, l: CanvasLink) => {
    openMenu(e, "连线", [
      item(l.label ? "编辑文字" : "添加文字", () => setEditingLink(l.id), { testId: "menu-link-label" }),
      item("反过来", () => edit((d) => reverseLink(d, l.id))),
      SEP,
      item("删除连线", () => edit((d) => removeLink(d, l.id)), { danger: true, testId: "menu-link-delete" }),
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
    (shown?.nodes ?? []).filter((n) => n.kind === "task").map((n) => [(n as { taskId: Id }).taskId, { x: n.pos.x, y: n.pos.y, ...(n.size ?? { w: CARD_W, h: cardHeight(cardTaskById.get((n as { taskId: Id }).taskId)) }) }]),
  );
  const describedTask = describing ? anyTaskById.get(describing) : undefined;
  // The 详情框's card (or group) in the viewport's pixels: the box sits beside it wherever the view has put it.
  const selectedRect = (() => {
    if (!selection || !shown) return null;
    if (selection.kind === "group") return shown.groups.find((g) => g.id === selection.id)?.rect ?? null;
    const n = nodeById.get(selection.id);
    return n ? rectOf(n) : null;
  })();
  const onScreen = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * view.k + view.x, y: r.y * view.k + view.y, w: r.w * view.k, h: r.h * view.k });
  const detailAnchor = selectedRect && onScreen(selectedRect);
  // The other cards, which the box tries not to cover (the side covering least of them wins).
  const detailAvoid = selectedRect && !compact ? (shown?.nodes ?? []).filter((n) => !(selection?.kind === "node" && n.id === selection.id)).map((n) => onScreen(rectOf(n))) : [];

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
      {notice && (
        <div role={notice.error ? "alert" : "status"} className={notice.error ? "toast toast-error" : "toast"} data-testid="canvas-notice">
          <span>{notice.text}</span>
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      </div>
      <div className="canvas-row">
      <div
        className={drag?.kind === "pan" ? "canvas-viewport panning" : "canvas-viewport"}
        ref={viewport}
        style={gridStyle(view)}
        onMouseDown={startPan}
        onContextMenu={canvasMenu}
        data-testid="canvas-viewport"
        data-linking={linkFrom ? "true" : undefined}
        data-connecting={drawing ? "true" : undefined}
      >
        <div className="canvas-world" ref={world} data-testid="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
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
                  className="group-remove soft-danger"
                  aria-label={`删除分组 ${g.title}`}
                  title="删除分组（会问卡片留下还是一起删）"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => askDeleteGroup(g.id)}
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
              <marker id="amo-link-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 Z" style={{ fill: "var(--link-line)" }} />
              </marker>
            </defs>
            {(shown?.links ?? []).map((l) => {
              const from = nodeById.get(l.from);
              const to = nodeById.get(l.to);
              if (!from || !to) return null;
              const { d } = linkCurve(sidePoint(rectOf(from), l.fromSide), l.fromSide, sidePoint(rectOf(to), l.toSide), l.toSide);
              return (
                <g key={l.id}>
                  <path d={d} className="canvas-link" markerEnd="url(#amo-link-arrow)" data-testid="canvas-link" data-link-id={l.id} />
                  <path
                    d={d}
                    className="canvas-edge-hit canvas-link-hit"
                    onMouseDown={(ev) => ev.stopPropagation()}
                    onDoubleClick={() => setEditingLink(l.id)}
                    onContextMenu={(ev) => linkMenu(ev, l)}
                    data-testid="canvas-link-hit"
                  />
                </g>
              );
            })}
            {drawing &&
              (() => {
                const from = nodeById.get(drawing.from);
                if (!from) return null;
                return <path d={linkCurve(sidePoint(rectOf(from), drawing.side), drawing.side, drawing.at, null).d} className="canvas-link drawing" markerEnd="url(#amo-link-arrow)" data-testid="canvas-link-drawing" />;
              })()}
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
              return <NoteCard key={node.id} node={node} selected={selected} flag={flags.get(node.id)} handles={handlesOf(node.id)} onMouseDown={(e) => startDrag(e, "node", node.id)} onContextMenu={(e) => noteMenu(e, node)} onEdit={editNote} />;
            }
            if (node.kind === "item") {
              return (
                <ItemCard
                  key={node.id}
                  node={node}
                  activity={itemActivity(node, callouts, sessions)}
                  flag={flags.get(node.id)}
                  selected={selected}
                  handles={handlesOf(node.id)}
                  onOpen={() => {
                    if (!compact) return setSelection({ kind: "node", id: node.id });
                    // No sidebar here: its bubble, else the session that laid it out.
                    const c = callouts.find((x) => x.target === node.id && x.state !== "closed");
                    if (c) focusCallout(c);
                    else if (node.sessionId) openSession(node.sessionId);
                  }}
                  onMouseDown={(e) => startDrag(e, "node", node.id)}
                  onContextMenu={(e) => itemMenu(e, node)}
                />
              );
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
                  flag={flags.get(node.id)}
                  handles={handlesOf(node.id)}
                  onOpen={() => target && onOpenTask(target.id)}
                  onMouseDown={(e) => startDrag(e, "node", node.id)}
                  onContextMenu={(e) => refMenu(e, node, target)}
                />
              );
            }
            const task = cardTaskById.get(node.taskId);
            if (!task) return null;
            return (
              <TaskCard
                key={node.id}
                node={node}
                task={task}
                sessions={sessions}
                workspaces={workspaces}
                selected={selected}
                flag={flags.get(task.id) ?? flags.get(node.id)}
                linking={!!linkFrom && linkFrom !== task.id && !task.archivedAt}
                handles={handlesOf(node.id)}
                onOpen={() => onOpenTask(task.id)}
                onMouseDown={(e) => {
                  if (linkFrom && e.button === 0 && !task.archivedAt) {
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
          {/* 连线 labels over the cards; double-click a line (or its label) to write one. */}
          {(shown?.links ?? []).map((l) => {
            const from = nodeById.get(l.from);
            const to = nodeById.get(l.to);
            if (!from || !to) return null;
            const { mid } = linkCurve(sidePoint(rectOf(from), l.fromSide), l.fromSide, sidePoint(rectOf(to), l.toSide), l.toSide);
            if (editingLink === l.id) {
              return (
                <input
                  key={l.id}
                  className="canvas-link-input"
                  style={{ left: mid.x, top: mid.y }}
                  defaultValue={l.label ?? ""}
                  maxLength={CANVAS_LINK_LABEL_MAX}
                  placeholder="连线上的文字"
                  aria-label="连线上的文字"
                  autoFocus
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      cancelLabel.current = true;
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => saveLabel(l.id, e.currentTarget.value)}
                  data-testid="canvas-link-input"
                />
              );
            }
            if (!l.label) return null;
            return (
              <div
                key={l.id}
                className="canvas-link-label"
                style={{ left: mid.x, top: mid.y }}
                title="双击修改文字，右键看更多"
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={() => setEditingLink(l.id)}
                onContextMenu={(e) => linkMenu(e, l)}
                data-testid="canvas-link-label"
              >
                {l.label}
              </div>
            );
          })}
          <CalloutLayer callouts={callouts} sessions={sessions} anchor={anchorOf} onOpen={focusCallout} onClose={closeCallout} onMore={() => showTab("talk")} />
        </div>

        <div className="canvas-tools" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          {!compact && (
          <>
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
          {window.amo?.openCanvasMini && (
            <button type="button" className="btn-ghost small" onClick={() => void window.amo?.openCanvasMini?.({ topicId: topic.id })} title="在一个置顶的小窗里看这张画布，做别的事时也能看到问题和进度" data-testid="canvas-open-mini">
              小窗
            </button>
          )}
          </>
          )}
          {openQuestions.length > 0 && (
            <button type="button" className="btn-ghost small canvas-asking" onClick={() => focusCallout(openQuestions[0]!)} title="跳到最早的一个问题并打开它" data-testid="canvas-asking">
              ? {openQuestions.length} 个问题待你确认
            </button>
          )}
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
        {!compact && <div className="canvas-hint">拖空白处移动视角 · 滚轮缩放 · 从卡片边上的圆点拖出连线 · 单击看详情 · 右键看更多操作 · 双击打开任务</div>}
        {!compact && (
          <button
            type="button"
            className="btn-ghost small sidebar-toggle canvas-side-toggle"
            aria-pressed={sideOpen}
            title={sideOpen ? "收起侧栏" : "显示侧栏：整体待办、沟通、文档、书签、agent 视角"}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onClick={() => setSideOpen(!sideOpen)}
            data-testid="canvas-sidebar-toggle"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="1" />
              <path d="M10 2.5v11" />
            </svg>
            侧栏
            {!sideOpen && openQuestions.length > 0 && <span className="sidebar-count" title={`${openQuestions.length} 个问题待你确认`}>{openQuestions.length}</span>}
          </button>
        )}
        {shown && selection && !compact && (
          <CanvasDetail
            anchor={detailAnchor}
            avoid={detailAvoid}
            area={area}
            hidden={!!preview}
            onClose={() => setSelectionState(null)}
            doc={shown}
            selection={selection}
            tasks={tasks}
            allTasks={allTasks}
            topics={topics}
            sessions={sessions}
            workspaces={workspaces}
            onChange={persist}
            onEdit={edit}
            onClearSelection={() => setSelectionState(null)}
            onDeleteGroup={askDeleteGroup}
            onOpenTask={onOpenTask}
            onDescribe={(taskId) => setDescribing(taskId)}
            newId={newCanvasId}
            renderItem={(it) => (
            <ItemDetail
              key={it.id}
              item={it}
              sessions={sessions}
              callouts={callouts}
              activity={itemActivity(it, callouts, sessions)}
              onStatus={(status) => setItemStatus(it.id, status)}
              onDiscuss={() => discuss(it)}
              onOpenSession={openSession}
              onFocus={focusCallout}
              onDelete={() => deleteItem(it.id)}
            />
          )}
          />
        )}
      </div>
      {shown && !compact && sideOpen && (
        <>
          {sideW.handle("调整画布侧栏宽度")}
          <CanvasSidebar
            width={sideW.width}
            tab={tab}
            onTab={setTab}
            todoTab={planning ? <TodoTab link={link} workspaces={workspaces} profiles={profiles} onOpenTask={onOpenTask} activity={activity} topicId={topic.id} /> : undefined}
            agentTab={<AgentTab link={link} topicId={topic.id} />}
            docsTab={<DocsTab link={link} topicId={topic.id} readOnly={!!topic.archivedAt} />}
            marksTab={<TopicBookmarks link={link} state={{ tasks: allTasks, sessions, topics, workspaces }} topicId={topic.id} />}
            talkTab={<TalkTab items={items} callouts={callouts} nameOf={targetName} onFocus={focusCallout} />}
            talkCount={openQuestions.length}
          />
        </>
      )}
      </div>
      {menu && <CanvasMenu x={menu.x} y={menu.y} label={menu.label} entries={menu.entries} onClose={closeMenu} />}
      {describedTask && <DescriptionDialog link={link} task={describedTask} onClose={() => setDescribing(null)} />}
      {deletingGroup && doc?.groups.some((g) => g.id === deletingGroup) && (
        <DeleteGroupDialog
          key={deletingGroup}
          doc={doc}
          group={doc.groups.find((g) => g.id === deletingGroup)!}
          onCancel={() => setDeletingGroup(null)}
          onConfirm={(withCards) => {
            const id = deletingGroup;
            setDeletingGroup(null);
            // Review items that go take the bubbles still out on them, as 删除条目 does.
            const goneItems = withCards ? new Set(doc.nodes.filter((n) => n.groupId === id && n.kind === "item").map((n) => n.id)) : new Set<Id>();
            edit((d) => (withCards ? deleteGroupAndCards(d, id) : deleteGroup(d, id)));
            for (const c of callouts) if (goneItems.has(c.target) && c.state !== "closed") closeCallout(c);
            setSelectionState((s) => (s && (s.kind === "group" ? s.id === id : withCards && doc.nodes.some((n) => n.id === s.id && n.groupId === id)) ? null : s));
          }}
        />
      )}
      {shownCallout && (
        <CalloutDialog
          key={shownCallout.id}
          link={link}
          callout={shownCallout}
          where={targetName(shownCallout.target)}
          author={shownCallout.sessionId ? sessionById.get(shownCallout.sessionId) : undefined}
          onOpenSession={shownCallout.sessionId && sessionById.get(shownCallout.sessionId)?.taskId ? () => openSession(shownCallout.sessionId!) : undefined}
          onClose={() => setOpenCallout(null)}
        />
      )}
    </section>
  );
}
