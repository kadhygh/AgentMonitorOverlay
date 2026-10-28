import { useEffect, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { projectWorkspaces, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { togglePin, usePins, type PinKind } from "../lib/pins.js";
import { moveNav, navOrder, useNavOrder } from "./navOrder.js";
import type { Scope } from "./Board.js";
import { UsageFooter } from "./UsageFooter.js";
import { KindIcon } from "./KindIcon.js";
import { GroupItems, ProjectReviewMenu, type MenuGroups, type ProjectMenuAt } from "../gitreview/ProjectReviewMenu.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { EditProjectDialog } from "./EditProjectDialog.js";
import { EditTopicDialog } from "./EditTopicDialog.js";
import { useDragWidth, useNavWidthVar } from "../lib/dragWidth.js";
import { FoldIcon } from "../task/SessionTree.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { useStoredIds } from "../lib/storedIds.js";
import { needsPerson } from "../lib/status.js";
import { fromProjectGroups, fromTopicGroups, groupEntries, groupOwners, joinGroup, moveGroup, toProjectGroups, toTopicGroups, type NavGroup } from "./navGroups.js";
import { EditGroupDialog } from "./EditGroupDialog.js";

/** The left column folded to a strip (2026-10-14), remembered per window. */
const NAV_FOLD_KEY = "amo.navCollapsed";
function readNavFolded(): boolean {
  try {
    return localStorage.getItem(NAV_FOLD_KEY) === "1";
  } catch {
    return false;
  }
}
import { showToast } from "../lib/toast.js";
import { useWaitingQuestions } from "../canvas/useCallouts.js";
import { pickFolder } from "../lib/profiles.js";
import { remoteWaiting, useRemote } from "../settings/remote.js";

/** A project or topic about to be archived from its right-click menu. */
type Archiving = { kind: "workspace" | "topic"; id: string; name: string };
type NavDrag = { type: "item"; kind: PinKind; id: string } | { type: "section"; kind: PinKind } | { type: "group"; kind: PinKind; id: string };
type NavDrop = NavDrag & { after: boolean };
/** A project or topic dragged onto a group's heading (of its own kind) goes into that group. */
type GroupDrop = { type: "into"; kind: PinKind; groupId: string };
/** 新建分组 (with the project or topic it was asked from) or 编辑分组. */
type EditingGroup = { kind: PinKind; creating: true; memberId: string } | { kind: PinKind; creating: false; id: string };

/** Groups folded in the left column (项目分组 and 专题分组), per machine. */
const GROUP_FOLD_KEY = "amo.navGroupsFolded";

interface ScopeNavProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
  /** For the dot on a folded group that has something waiting for the person. */
  sessions?: readonly Session[];
  scope: Scope;
  live: boolean;
  /** Opens the settings (the button under the Host status). */
  onSettings?: () => void;
  onScope(scope: Scope): void;
}

const isCurrent = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind === "all" || (b.kind !== "all" && a.id === b.id));

const FOLD_KEY = "amo.navFolded";
function readFolded(): Record<PinKind, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") as Partial<Record<PinKind, boolean>>;
    return { topic: v.topic === true, project: v.project === true };
  } catch {
    return { topic: false, project: false };
  }
}

/**
 * Left column: all tasks, then topics and projects (the common space is not listed). Topics and projects can be
 * pinned (they come first, here and wherever they are picked) and each section folds down to its pinned entries. The
 * lists scroll between the fixed top and the Host / usage footer.
 */
export function ScopeNav({ link, workspaces, topics, tasks, sessions = [], scope, live, onScope, onSettings }: ScopeNavProps) {
  const [adding, setAdding] = useState(false);
  const [newTopic, setNewTopic] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [folded, setFolded] = useState(readFolded);
  const [menu, setMenu] = useState<ProjectMenuAt | null>(null);
  const [topicMenu, setTopicMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [archiving, setArchiving] = useState<Archiving | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingTopicId, setEditingTopic] = useState<string | null>(null);
  const [collapsed, setCollapsedState] = useState(readNavFolded);
  // 远程 (2026-10-29): a pairing request waits → a dot beside 设置 (not a place of its own on the main window).
  const remoteWaits = remoteWaiting(useRemote(link)) > 0;
  const settingsTitle = remoteWaits ? "设置：远程有请求或回复等你看（设置 → 远程）" : "设置：界面主题、公共目录、模型、便签、功能、数据管理";
  // The column's width, dragged at its right edge (2026-10-15); it also lines up the brand in the title bar.
  const navW = useDragWidth("amo.navWidth", 224, 180, 420);
  useNavWidthVar(navW.width, !collapsed);
  const setCollapsed = (on: boolean) => {
    setCollapsedState(on);
    try {
      localStorage.setItem(NAV_FOLD_KEY, on ? "1" : "0");
    } catch {
      // per-window convenience only
    }
  };
  const editingWs = editing ? workspaces.find((w) => w.id === editing) : undefined;
  const editingTopic = editingTopicId ? topics.find((t) => t.id === editingTopicId) : undefined;
  const pins = usePins();
  const topicOrder = useNavOrder("topic");
  const projectOrder = useNavOrder("project");
  const sectionOrder = useNavOrder("sections");
  const sectionRows = navOrder<PinKind>(["topic", "project"], sectionOrder.ids, [], (kind) => kind);
  const orders = { topic: topicOrder, project: projectOrder };
  const [dragging, setDragging] = useState<NavDrag | null>(null);
  const [over, setOver] = useState<NavDrop | GroupDrop | null>(null);
  const endDrag = () => { setDragging(null); setOver(null); };
  const afterMiddle = (e: DragEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };
  const startDrag = (e: DragEvent, item: NavDrag) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-amo-nav", JSON.stringify(item));
    setDragging(item);
  };
  const liveTasks = tasks.filter((t) => !t.archivedAt);

  // 项目分组 (2026-10-22, design B 树形) and 专题分组 (2026-10-27, the same): kept by the Host with the settings;
  // folding is per machine.
  const settings = useSettings(link);
  const groupsOf: Record<PinKind, NavGroup[]> = { project: fromProjectGroups(settings?.projectGroups ?? []), topic: fromTopicGroups(settings?.topicGroups ?? []) };
  const ownerOf: Record<PinKind, Map<string, string>> = { project: groupOwners(groupsOf.project), topic: groupOwners(groupsOf.topic) };
  // 画布审阅: questions waiting on each topic's canvas.
  const asking = useWaitingQuestions(link);
  const groupFolded = useStoredIds(GROUP_FOLD_KEY);
  const [groupMenu, setGroupMenu] = useState<{ kind: PinKind; id: string; x: number; y: number } | null>(null);
  const [editingGroup, setEditingGroup] = useState<EditingGroup | null>(null);
  const saveGroups = async (kind: PinKind, next: readonly NavGroup[]) => {
    await call(link, "PUT /api/settings", {}, kind === "project" ? { projectGroups: toProjectGroups(next) } : { topicGroups: toTopicGroups(next) });
  };
  const changeGroups = (kind: PinKind, next: readonly NavGroup[]) => void saveGroups(kind, next).catch((err) => showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true }));
  // Projects and topics with a session waiting for the person (approval, answer, review); topics also with a question
  // on their canvas.
  const waitingTasks = liveTasks.filter((t) => sessions.some((s) => s.taskId === t.id && !s.archivedAt && needsPerson(s.status)));
  const waiting: Record<PinKind, Set<string>> = { project: new Set(waitingTasks.map((t) => t.workspaceId)), topic: new Set([...waitingTasks.flatMap((t) => (t.topicId ? [t.topicId] : [])), ...Object.keys(asking)]) };
  /** What the menus of a project or topic offer for its groups. */
  const menuGroups = (kind: PinKind, memberId: string): MenuGroups => ({
    groups: groupsOf[kind],
    current: ownerOf[kind].get(memberId) ?? null,
    onJoin: (id) => changeGroups(kind, joinGroup(groupsOf[kind], memberId, id)),
    onNew: () => setEditingGroup({ kind, creating: true, memberId }),
    onLeave: () => changeGroups(kind, joinGroup(groupsOf[kind], memberId, null)),
  });

  const fold = (kind: PinKind) =>
    setFolded((f) => {
      const next = { ...f, [kind]: !f[kind] };
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        // per-viewer convenience only
      }
      return next;
    });

  const row = (kind: PinKind | null, id: string | null, target: Scope, name: string, count: number, testId: string, title?: string, onMenu?: (e: MouseEvent) => void, badge?: ReactNode) => {
    const pinned = !!(kind && id && pins.has(kind, id));
    return (
      <div key={testId} className={pinned ? "nav-item pinned" : "nav-item"} title={title}
        data-dragging={dragging?.type === "item" && dragging.kind === kind && dragging.id === id || undefined}
        data-drop={over?.type === "item" && over.kind === kind && over.id === id ? over.after ? "after" : "before" : undefined}
        onDragOver={(e) => {
          if (!kind || !id || dragging?.type !== "item" || dragging.kind !== kind || dragging.id === id || !dropsOn(kind, dragging.id, id)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setOver({ type: "item", kind, id, after: afterMiddle(e) });
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((cur) => cur?.type === "item" && cur.kind === kind && cur.id === id ? null : cur);
        }}
        onDrop={(e) => {
          if (!kind || !id || dragging?.type !== "item" || dragging.kind !== kind || !dropsOn(kind, dragging.id, id)) return;
          e.preventDefault();
          e.stopPropagation();
          // Onto an entry of another group (or of none): it changes group there.
          if (ownerOf[kind].get(dragging.id) !== ownerOf[kind].get(id)) changeGroups(kind, joinGroup(groupsOf[kind], dragging.id, ownerOf[kind].get(id) ?? null));
          moveItem(kind, dragging.id, id, afterMiddle(e));
          endDrag();
        }}
      >
        <button type="button" className="nav-row" aria-current={isCurrent(scope, target)} onClick={() => onScope(target)} onContextMenu={onMenu} data-testid={testId}
          draggable={!!kind && !!id}
          title={kind ? [title, "拖动排序；Alt ↑ / ↓ 调整顺序（置顶项在前）"].filter(Boolean).join("\n") : title}
          onDragStart={(e) => { if (kind && id) startDrag(e, { type: "item", kind, id }); }}
          onDragEnd={endDrag}
          onKeyDown={(e) => {
            if (!kind || !id || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            const list = lists[kind].filter((item) => pins.has(kind, item.id) === pinned && ownerOf[kind].get(item.id) === ownerOf[kind].get(id));
            const target = list[list.findIndex((item) => item.id === id) + (e.key === "ArrowDown" ? 1 : -1)];
            if (target) moveItem(kind, id, target.id, e.key === "ArrowDown");
          }}
        >
          {kind && <NavKindIcon kind={kind} />}
          <span className="name">{name}</span>
          {pinned && (
            <svg className="nav-pinned" width="11" height="11" viewBox="0 0 12 12" role="img" aria-label="已置顶">
              <path d="M4 1.5 H8 L7.4 5 L9.5 7 H2.5 L4.6 5 Z M6 7 V11" />
            </svg>
          )}
          {badge}
          <span className="count">{count}</span>
        </button>
        {kind && id && (
          <button
            type="button"
            className="pin-btn"
            aria-pressed={pinned}
            aria-label={pinned ? `取消置顶 ${name}` : `置顶 ${name}`}
            title={pinned ? "取消置顶" : "置顶：排在最前，折叠时也留着"}
            onClick={() => togglePin(kind, id)}
            data-testid="pin"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4 1.5 H8 L7.4 5 L9.5 7 H2.5 L4.6 5 Z M6 7 V11" />
            </svg>
          </button>
        )}
      </div>
    );
  };

  // Folded sections keep their pinned entries, and the one in scope.
  const shown = <T,>(kind: PinKind, items: readonly T[], id: (x: T) => string): T[] => {
    const ordered = navOrder(items, orders[kind].ids, pins[kind], id);
    if (!folded[kind]) return ordered;
    return ordered.filter((x) => pins.has(kind, id(x)) || (scope.kind === (kind === "topic" ? "topic" : "workspace") && scope.id === id(x)));
  };
  const liveTopics = topics.filter((t) => !t.archivedAt);
  const projects = projectWorkspaces(workspaces);
  const topicRows = shown("topic", liveTopics, (t) => t.id);
  const projectRows = shown("project", projects, (w) => w.id);
  const groupedProjects = groupEntries(projectRows, groupsOf.project);
  const groupedTopics = groupEntries(topicRows, groupsOf.topic);
  const lists = {
    topic: navOrder(liveTopics, topicOrder.ids, pins.topic, (t) => t.id),
    project: navOrder(projects, projectOrder.ids, pins.project, (w) => w.id),
  };
  function moveItem(kind: PinKind, from: string, to: string, after: boolean) {
    orders[kind].save(moveNav(lists[kind].map((item) => item.id), from, to, after));
  }
  /** Within a list pinned and unpinned entries keep apart; an entry may also go to another group. */
  function dropsOn(kind: PinKind, from: string, to: string): boolean {
    if (ownerOf[kind].get(from) !== ownerOf[kind].get(to)) return true;
    return pins.has(kind, from) === pins.has(kind, to);
  }
  const topicRow = (t: Topic) =>
    row(
      "topic",
      t.id,
      { kind: "topic", id: t.id },
      t.title,
      liveTasks.filter((x) => x.topicId === t.id).length,
      `scope-topic-${t.title}`,
      asking[t.id] ? `画布上 ${asking[t.id]} 个问题待你确认` : undefined,
      (e) => {
        e.preventDefault();
        setTopicMenu({ id: t.id, x: e.clientX, y: e.clientY });
      },
      asking[t.id] ? (
        <span className="nav-asking" data-testid="nav-asking">
          ? {asking[t.id]}
        </span>
      ) : undefined,
    );
  const projectRow = (w: Workspace) =>
    row("project", w.id, { kind: "workspace", id: w.id }, w.name, liveTasks.filter((t) => t.workspaceId === w.id).length, `scope-ws-${w.name}`, w.description ? `${w.path}\n${w.description}` : w.path, (e) => {
      e.preventDefault();
      setMenu({ workspaceId: w.id, x: e.clientX, y: e.clientY });
    });

  // A group's heading: folds it, takes entries of its kind dragged onto it, drags to reorder the groups of its kind,
  // right-click to edit.
  const groupHead = (kind: PinKind, g: NavGroup, members: readonly { id: string }[]) => {
    const open = !groupFolded.has(g.id);
    const alert = !open && members.some((m) => waiting[kind].has(m.id));
    const drop = over?.type === "into" && over.groupId === g.id ? "into" : over?.type === "group" && over.id === g.id ? (over.after ? "after" : "before") : undefined;
    const what = kind === "project" ? "项目" : "专题";
    return (
      <div className="nav-item" data-drop={drop} data-dragging={(dragging?.type === "group" && dragging.id === g.id) || undefined}
        onDragOver={(e) => {
          if (dragging?.type === "item" && dragging.kind === kind && ownerOf[kind].get(dragging.id) !== g.id) {
            e.preventDefault();
            e.stopPropagation();
            setOver({ type: "into", kind, groupId: g.id });
          } else if (dragging?.type === "group" && dragging.kind === kind && dragging.id !== g.id) {
            e.preventDefault();
            e.stopPropagation();
            setOver({ type: "group", kind, id: g.id, after: afterMiddle(e) });
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((cur) => (cur?.type === "into" && cur.groupId === g.id) || (cur?.type === "group" && cur.id === g.id) ? null : cur);
        }}
        onDrop={(e) => {
          if (dragging?.type === "item" && dragging.kind === kind) changeGroups(kind, joinGroup(groupsOf[kind], dragging.id, g.id));
          else if (dragging?.type === "group" && dragging.kind === kind) changeGroups(kind, moveGroup(groupsOf[kind], dragging.id, g.id, afterMiddle(e)));
          else return;
          e.preventDefault();
          e.stopPropagation();
          endDrag();
        }}
      >
        <button type="button" className="nav-row nav-group-head" aria-expanded={open} draggable data-testid={kind === "project" ? `group-${g.name}` : `topic-group-${g.name}`}
          title={[g.name, g.description, open ? `点一下折叠；右键编辑或解散；拖动调整分组顺序；把${what}拖到这里放进分组` : "点一下展开"].filter(Boolean).join("\n")}
          onClick={() => groupFolded.toggle(g.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setGroupMenu({ kind, id: g.id, x: e.clientX, y: e.clientY });
          }}
          onDragStart={(e) => startDrag(e, { type: "group", kind, id: g.id })}
          onDragEnd={endDrag}
        >
          <span className="nav-group-chev" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <GroupIcon />
          <span className="name">{g.name}</span>
          {alert && <span className="nav-group-alert" title="组里有等你处理的会话或画布问题" aria-label="组里有等你处理的会话或画布问题" data-testid="group-alert" />}
          <span className="count">{members.length}</span>
        </button>
      </div>
    );
  };
  const sectionDrop = (kind: PinKind) => ({
    "data-drop": over?.type === "section" && over.kind === kind ? over.after ? "after" : "before" : undefined,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (dragging?.type !== "section" || dragging.kind === kind) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver({ type: "section", kind, after: sectionRows.indexOf(dragging.kind) < sectionRows.indexOf(kind) });
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((cur) => cur?.type === "section" && cur.kind === kind ? null : cur);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (dragging?.type !== "section" || dragging.kind === kind) return;
      e.preventDefault();
      sectionOrder.save(moveNav(sectionRows, dragging.kind, kind, sectionRows.indexOf(dragging.kind) < sectionRows.indexOf(kind)));
      endDrag();
    },
  });

  // Section heads are small spaced labels with a rule to the +, apart from the entries under them (2026-10-15, design A);
  // the label folds the section, and a folded one shows ▸.
  const head = (kind: PinKind, label: string, total: number, add: () => void, addLabel: string) => (
    <div className="nav-head" draggable title="拖动标题调整项目和专题模块的上下顺序" onDragStart={(e) => startDrag(e, { type: "section", kind })} onDragEnd={endDrag}>
      <button type="button" className="nav-fold" aria-expanded={!folded[kind]} onClick={() => fold(kind)} title={folded[kind] ? "展开" : "折叠：只留置顶的"} data-testid={`fold-${kind}`}>
        {folded[kind] && (
          <span className="nav-chev" aria-hidden="true">
            ▸
          </span>
        )}
        {label}
        <span className="nav-total">{total}</span>
      </button>
      <span className="nav-rule" aria-hidden="true" />
      <button type="button" className="nav-add" onClick={add} aria-label={addLabel} title={addLabel}>
        +
      </button>
    </div>
  );

  async function archive(target: Archiving) {
    setArchiveBusy(true);
    try {
      if (target.kind === "workspace") await call(link, "POST /api/workspaces/:id/archive", { id: target.id });
      else await call(link, "POST /api/topics/:id/archive", { id: target.id });
      if (scope.kind === (target.kind === "workspace" ? "workspace" : "topic") && scope.id === target.id) onScope({ kind: "all" });
      setArchiving(null);
    } catch (err) {
      showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setArchiveBusy(false);
    }
  }

  async function register(dir: string) {
    if (!dir.trim()) return;
    setBusy(true);
    setError("");
    try {
      const ws = await call(link, "POST /api/workspaces", {}, { path: dir.trim() });
      setPath("");
      setAdding(false);
      onScope({ kind: "workspace", id: ws.id });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    const dir = await pickFolder();
    if (dir) await register(dir);
  }

  if (collapsed)
    return (
      <nav className="scope-nav collapsed" aria-label="范围">
        <span className="spacer" />
        {onSettings && (
          <button type="button" className="fold-btn nav-settings-folded" onClick={onSettings} aria-label="设置" title={remoteWaits ? settingsTitle : "设置"}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.9 1.5h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5Z" />
              <circle cx="8" cy="8" r="2.2" />
            </svg>
            {remoteWaits && <span className="settings-dot corner" aria-hidden="true" data-testid="settings-dot" />}
          </button>
        )}
        <button type="button" className="fold-btn" aria-label="展开左栏" title="展开左栏" onClick={() => setCollapsed(false)} data-testid="nav-expand">
          <FoldIcon dir="right" />
        </button>
      </nav>
    );

  return (
    <>
    <nav className="scope-nav" aria-label="范围">
      <div className="nav-top">{row(null, null, { kind: "all" }, "全部任务", liveTasks.length, "scope-all")}</div>

      <div className="nav-scroll">
        {sectionRows.map((kind) => kind === "topic" ? (
        <section key="topic" className="nav-section-box" aria-label="专题" {...sectionDrop("topic")}>
          {head("topic", "专题", liveTopics.length, () => setNewTopic(""), "新专题")}
          {folded.topic || groupsOf.topic.length === 0 ? (
            topicRows.map(topicRow)
          ) : (
            <>
              {groupedTopics.groups.map(({ group: g, entries: members }) => {
                // Folded, a group still shows the topic in scope.
                const inside = groupFolded.has(g.id) ? members.filter((t) => scope.kind === "topic" && scope.id === t.id) : members;
                return (
                  <div key={g.id} className="nav-group" role="group" aria-label={g.name}>
                    {groupHead("topic", g, members)}
                    {inside.length > 0 && <div className="nav-group-body">{inside.map(topicRow)}</div>}
                  </div>
                );
              })}
              {groupedTopics.loose.map(topicRow)}
            </>
          )}
          {folded.topic && topicRows.length < liveTopics.length && (
            <button type="button" className="nav-more" onClick={() => fold("topic")}>
              还有 {liveTopics.length - topicRows.length} 个专题
            </button>
          )}
          {newTopic === null ? (
            !folded.topic &&
            liveTopics.length === 0 && (
              <button type="button" className="add-ws-toggle" onClick={() => setNewTopic("")} data-testid="new-topic">
                + 新专题
              </button>
            )
          ) : (
            <form
              className="add-ws"
              onSubmit={(e) => {
                e.preventDefault();
                const title = newTopic.trim();
                if (!title) return;
                void call(link, "POST /api/topics", {}, { title }).then((topic) => {
                  setNewTopic(null);
                  onScope({ kind: "topic", id: topic.id });
                });
              }}
            >
              <input className="field" autoFocus value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="专题名称" aria-label="专题名称" />
              <div className="add-ws-actions">
                <button type="submit" className="btn-primary" disabled={!newTopic.trim()}>
                  建立
                </button>
                <button type="button" className="btn-ghost" onClick={() => setNewTopic(null)}>
                  取消
                </button>
              </div>
            </form>
          )}
        </section>
        ) : (
        <section key="project" className="nav-section-box" aria-label="项目" {...sectionDrop("project")}>
          {head("project", "项目", projects.length, () => setAdding(true), "添加项目")}
          {folded.project || groupsOf.project.length === 0 ? (
            projectRows.map(projectRow)
          ) : (
            <>
              {groupedProjects.groups.map(({ group: g, entries: members }) => {
                // Folded, a group still shows the project in scope.
                const inside = groupFolded.has(g.id) ? members.filter((w) => scope.kind === "workspace" && scope.id === w.id) : members;
                return (
                  <div key={g.id} className="nav-group" role="group" aria-label={g.name}>
                    {groupHead("project", g, members)}
                    {inside.length > 0 && <div className="nav-group-body">{inside.map(projectRow)}</div>}
                  </div>
                );
              })}
              {groupedProjects.loose.map(projectRow)}
            </>
          )}
          {folded.project && projectRows.length < projects.length && (
            <button type="button" className="nav-more" onClick={() => fold("project")}>
              还有 {projects.length - projectRows.length} 个项目
            </button>
          )}
          <div className="add-ws">
            {!adding ? (
              !folded.project &&
              projects.length === 0 && (
                <button type="button" className="add-ws-toggle" onClick={() => setAdding(true)}>
                  + 添加项目
                </button>
              )
            ) : (
              <form
                className="add-ws"
                onSubmit={(e) => {
                  e.preventDefault();
                  void register(path);
                }}
              >
                {window.amo?.pickDirectory && (
                  <button type="button" className="btn-ghost" onClick={() => void pick()} disabled={busy}>
                    选择文件夹…
                  </button>
                )}
                <label className="stack-field">
                  或输入路径
                  <input className="field" value={path} onChange={(e) => setPath(e.target.value)} placeholder="D:\\Projects\\MyGame" aria-label="项目路径" />
                </label>
                {error && (
                  <span className="form-error" role="alert">
                    {error}
                  </span>
                )}
                <div className="add-ws-actions">
                  <button type="submit" className="btn-primary" disabled={busy || !path.trim()}>
                    登记
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setAdding(false);
                      setError("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
        ))}
      </div>

      <UsageFooter link={link} live={live} />
      {/* Settings and, at its right, folding the column (2026-10-15: beside 全部任务 it pushed that row short of the
          lists' right edge); folded, the same corner unfolds it. */}
      <div className="nav-bottom">
      {onSettings && (
        <button type="button" className="nav-settings" onClick={onSettings} aria-label="设置" title={settingsTitle}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.9 1.5h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5Z" />
            <circle cx="8" cy="8" r="2.2" />
          </svg>
          设置
          {remoteWaits && <span className="settings-dot" aria-hidden="true" data-testid="settings-dot" />}
        </button>
      )}
        <button type="button" className="fold-btn" aria-label="收起左栏" title="收起左栏" onClick={() => setCollapsed(true)} data-testid="nav-collapse">
          <FoldIcon dir="left" />
        </button>
      </div>
      {menu && (
        <ProjectReviewMenu
          link={link}
          at={menu}
          onClose={() => setMenu(null)}
          onEdit={() => setEditing(menu.workspaceId)}
          groups={menuGroups("project", menu.workspaceId)}
          onArchive={() => {
            const w = workspaces.find((x) => x.id === menu.workspaceId);
            if (w) setArchiving({ kind: "workspace", id: w.id, name: w.name });
          }}
        />
      )}
      {editingWs && <EditProjectDialog link={link} workspace={editingWs} onClose={() => setEditing(null)} />}
      {topicMenu && (
        <TopicMenu
          at={topicMenu}
          onClose={() => setTopicMenu(null)}
          onEdit={() => setEditingTopic(topicMenu.id)}
          groups={menuGroups("topic", topicMenu.id)}
          onArchive={() => {
            const t = topics.find((x) => x.id === topicMenu.id);
            if (t) setArchiving({ kind: "topic", id: t.id, name: t.title });
          }}
        />
      )}
      {editingTopic && <EditTopicDialog link={link} topic={editingTopic} onClose={() => setEditingTopic(null)} />}
      {groupMenu && (
        <GroupMenu
          at={groupMenu}
          onClose={() => setGroupMenu(null)}
          onEdit={() => setEditingGroup({ kind: groupMenu.kind, creating: false, id: groupMenu.id })}
          onDissolve={() => changeGroups(groupMenu.kind, groupsOf[groupMenu.kind].filter((g) => g.id !== groupMenu.id))}
        />
      )}
      {editingGroup && (
        <EditGroupDialog
          creating={editingGroup.creating}
          placeholder={editingGroup.kind === "project" ? "例如：Unity 客户端和它的资源仓库；发版前一起看改动。" : "例如：Studio 自己的几条线：画布、中转、Focus。"}
          {...(editingGroup.creating
            ? {}
            : { name: groupsOf[editingGroup.kind].find((g) => g.id === editingGroup.id)?.name ?? "", description: groupsOf[editingGroup.kind].find((g) => g.id === editingGroup.id)?.description ?? "" })}
          onSave={(name, description) =>
            saveGroups(
              editingGroup.kind,
              editingGroup.creating
                ? [...joinGroup(groupsOf[editingGroup.kind], editingGroup.memberId, null), { id: "", name, description, members: [editingGroup.memberId] }]
                : groupsOf[editingGroup.kind].map((g) => (g.id === editingGroup.id ? { ...g, name, description } : g)),
            )
          }
          onClose={() => setEditingGroup(null)}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={archiving.kind === "workspace" ? `归档项目「${archiving.name}」？` : `归档专题「${archiving.name}」？`}
          action={archiving.kind === "workspace" ? "归档项目" : "归档专题"}
          danger
          busy={archiveBusy}
          onCancel={() => setArchiving(null)}
          onConfirm={() => void archive(archiving)}
          testId="archive-scope-confirm"
        >
          <ul className="confirm-risks">
            {archiving.kind === "workspace" ? (
              <li>项目从左栏和所有选择列表里消失；它的 {liveTasks.filter((t) => t.workspaceId === archiving.id).length} 个任务和它们的会话一起归档，只能查看。</li>
            ) : (
              <li>专题和它的画布、{liveTasks.filter((t) => t.topicId === archiving.id).length} 个任务以及这些任务和专题自己的会话一起归档，只能查看。</li>
            )}
            {archiving.kind === "workspace" && <li>项目文件夹里的文件不受影响。</li>}
            <li>可以在 设置 → 数据管理 里恢复，或者彻底删除。</li>
          </ul>
        </ConfirmDialog>
      )}
    </nav>
    {navW.handle("调整左栏宽度")}
    </>
  );
}

/** Right-click menu of a topic in the left column. */
function TopicMenu({ at, onClose, onEdit, onArchive, groups }: { at: { x: number; y: number }; onClose(): void; onEdit(): void; onArchive(): void; groups: MenuGroups }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: globalThis.MouseEvent) => !(e.target as Element | null)?.closest?.(".ctx-menu") && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div className="ctx-menu" role="menu" aria-label="专题" style={{ left: at.x, top: at.y }}>
      <button
        type="button"
        role="menuitem"
        title="改专题的名字，写一段说明（agent 读专题时能看到）"
        onClick={() => {
          onEdit();
          onClose();
        }}
        data-testid="edit-topic-item"
      >
        编辑专题…
      </button>
      <GroupItems groups={groups} what="专题" onClose={onClose} />
      <button
        type="button"
        role="menuitem"
        className="menu-danger"
        title="专题、画布和它的任务、会话一起归档，从列表里隐藏；可以在 设置 → 数据管理 里恢复"
        onClick={() => {
          onArchive();
          onClose();
        }}
        data-testid="archive-topic"
      >
        归档专题…
      </button>
    </div>
  );
}

/** Right-click menu of a group's heading: 编辑分组 and 解散分组 (its projects or topics stay, out of any group). */
function GroupMenu({ at, onClose, onEdit, onDissolve }: { at: { x: number; y: number }; onClose(): void; onEdit(): void; onDissolve(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: globalThis.MouseEvent) => !(e.target as Element | null)?.closest?.(".ctx-menu") && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  const pick = (run: () => void) => () => {
    run();
    onClose();
  };
  return (
    <div className="ctx-menu" role="menu" aria-label="分组" style={{ left: at.x, top: at.y }}>
      <button type="button" role="menuitem" title="改分组的名字，写一段说明" onClick={pick(onEdit)} data-testid="edit-group-item">
        编辑分组…
      </button>
      <button type="button" role="menuitem" title="去掉这个分组；里面的项目或专题都留着，回到没分组的那一段" onClick={pick(onDissolve)} data-testid="dissolve-group">
        解散分组
      </button>
    </div>
  );
}

/** A project group: two folders stacked. */
function GroupIcon() {
  return (
    <svg className="nav-kind" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 3.6V3h2.4l1 1.1H11v.6" />
      <path d="M1.5 5.6V11.5h11V6.3H7L5.8 5.1H1.5z" />
    </svg>
  );
}

/** A topic's bookmark or a project's folder, before its name in the left column. */
function NavKindIcon({ kind }: { kind: PinKind }) {
  return <KindIcon kind={kind === "topic" ? "topic" : "workspace"} className="nav-kind" />;
}
