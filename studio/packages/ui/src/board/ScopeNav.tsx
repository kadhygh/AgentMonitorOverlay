import { useEffect, useState, type MouseEvent } from "react";
import { projectWorkspaces, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { pinnedFirst, togglePin, usePins, type PinKind } from "../lib/pins.js";
import type { Scope } from "./Board.js";
import { UsageFooter } from "./UsageFooter.js";
import { ProjectReviewMenu, type ProjectMenuAt } from "../gitreview/ProjectReviewMenu.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { EditProjectDialog } from "./EditProjectDialog.js";
import { EditTopicDialog } from "./EditTopicDialog.js";
import { useDragWidth, useNavWidthVar } from "../lib/dragWidth.js";
import { FoldIcon } from "../task/SessionTree.js";

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

/** A project or topic about to be archived from its right-click menu. */
type Archiving = { kind: "workspace" | "topic"; id: string; name: string };

interface ScopeNavProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
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
export function ScopeNav({ link, workspaces, topics, tasks, scope, live, onScope, onSettings }: ScopeNavProps) {
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
  const liveTasks = tasks.filter((t) => !t.archivedAt);

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

  const row = (kind: PinKind | null, id: string | null, target: Scope, name: string, count: number, testId: string, title?: string, onMenu?: (e: MouseEvent) => void) => {
    const pinned = !!(kind && id && pins.has(kind, id));
    return (
      <div key={testId} className={pinned ? "nav-item pinned" : "nav-item"} title={title}>
        <button type="button" className="nav-row" aria-current={isCurrent(scope, target)} onClick={() => onScope(target)} onContextMenu={onMenu} data-testid={testId}>
          {kind && <NavKindIcon kind={kind} />}
          <span className="name">{name}</span>
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
    const ordered = pinnedFirst(items, pins[kind], id);
    if (!folded[kind]) return ordered;
    return ordered.filter((x) => pins.has(kind, id(x)) || (scope.kind === (kind === "topic" ? "topic" : "workspace") && scope.id === id(x)));
  };
  const liveTopics = topics.filter((t) => !t.archivedAt);
  const projects = projectWorkspaces(workspaces);
  const topicRows = shown("topic", liveTopics, (t) => t.id);
  const projectRows = shown("project", projects, (w) => w.id);

  // Section heads are small spaced labels with a rule to the +, apart from the entries under them (2026-10-15, design A);
  // the label folds the section, and a folded one shows ▸.
  const head = (kind: PinKind, label: string, total: number, add: () => void, addLabel: string) => (
    <div className="nav-head">
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
    const dir = await window.amo?.pickDirectory?.();
    if (dir) await register(dir);
  }

  if (collapsed)
    return (
      <nav className="scope-nav collapsed" aria-label="范围">
        <span className="spacer" />
        {onSettings && (
          <button type="button" className="fold-btn" onClick={onSettings} aria-label="设置" title="设置">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.9 1.5h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5Z" />
              <circle cx="8" cy="8" r="2.2" />
            </svg>
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
        <section className="nav-section-box" aria-label="专题">
          {head("topic", "专题", liveTopics.length, () => setNewTopic(""), "新专题")}
          {topicRows.map((t) =>
            row("topic", t.id, { kind: "topic", id: t.id }, t.title, liveTasks.filter((x) => x.topicId === t.id).length, `scope-topic-${t.title}`, undefined, (e) => {
              e.preventDefault();
              setTopicMenu({ id: t.id, x: e.clientX, y: e.clientY });
            }),
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

        <section className="nav-section-box" aria-label="项目">
          {head("project", "项目", projects.length, () => setAdding(true), "添加项目")}
          {projectRows.map((w) =>
            row("project", w.id, { kind: "workspace", id: w.id }, w.name, liveTasks.filter((t) => t.workspaceId === w.id).length, `scope-ws-${w.name}`, w.description ? `${w.path}
${w.description}` : w.path, (e) => {
              e.preventDefault();
              setMenu({ workspaceId: w.id, x: e.clientX, y: e.clientY });
            }),
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
      </div>

      <UsageFooter link={link} live={live} />
      {/* Settings and, at its right, folding the column (2026-10-15: beside 全部任务 it pushed that row short of the
          lists' right edge); folded, the same corner unfolds it. */}
      <div className="nav-bottom">
      {onSettings && (
        <button type="button" className="nav-settings" onClick={onSettings} aria-label="设置" title="设置：界面主题、公共目录、模型、便签、功能、数据管理">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.9 1.5h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5Z" />
            <circle cx="8" cy="8" r="2.2" />
          </svg>
          设置
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
          onArchive={() => {
            const t = topics.find((x) => x.id === topicMenu.id);
            if (t) setArchiving({ kind: "topic", id: t.id, name: t.title });
          }}
        />
      )}
      {editingTopic && <EditTopicDialog link={link} topic={editingTopic} onClose={() => setEditingTopic(null)} />}
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
function TopicMenu({ at, onClose, onEdit, onArchive }: { at: { x: number; y: number }; onClose(): void; onEdit(): void; onArchive(): void }) {
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

/** A topic's bookmark or a project's folder, before its name in the left column. */
function NavKindIcon({ kind }: { kind: PinKind }) {
  return (
    <svg className="nav-kind" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {kind === "topic" ? <path d="M3 2.5h8v9l-4-2.6-4 2.6z" /> : <path d="M1.5 4V11.5h11V5H7L5.6 3H1.5z" />}
    </svg>
  );
}
