import { useState } from "react";
import { projectWorkspaces, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { pinnedFirst, togglePin, usePins, type PinKind } from "../lib/pins.js";
import type { Scope } from "./Board.js";
import { UsageFooter } from "./UsageFooter.js";

interface ScopeNavProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
  scope: Scope;
  live: boolean;
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
export function ScopeNav({ link, workspaces, topics, tasks, scope, live, onScope }: ScopeNavProps) {
  const [adding, setAdding] = useState(false);
  const [newTopic, setNewTopic] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [folded, setFolded] = useState(readFolded);
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

  const row = (kind: PinKind | null, id: string | null, target: Scope, name: string, count: number, testId: string, title?: string) => {
    const pinned = !!(kind && id && pins.has(kind, id));
    return (
      <div key={testId} className={pinned ? "nav-item pinned" : "nav-item"} title={title}>
        <button type="button" className="nav-row" aria-current={isCurrent(scope, target)} onClick={() => onScope(target)} data-testid={testId}>
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

  const head = (kind: PinKind, label: string, total: number, add: () => void, addLabel: string) => (
    <div className="nav-head">
      <button type="button" className="nav-fold" aria-expanded={!folded[kind]} onClick={() => fold(kind)} data-testid={`fold-${kind}`}>
        <span className="nav-chev" aria-hidden="true">
          {folded[kind] ? "▸" : "▾"}
        </span>
        {label}
        <span className="nav-total">{total}</span>
      </button>
      <button type="button" className="nav-add" onClick={add} aria-label={addLabel} title={addLabel}>
        +
      </button>
    </div>
  );

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

  return (
    <nav className="scope-nav" aria-label="范围">
      <div className="nav-top">{row(null, null, { kind: "all" }, "全部任务", liveTasks.length, "scope-all")}</div>

      <div className="nav-scroll">
        <section className="nav-section-box" aria-label="专题">
          {head("topic", "专题", liveTopics.length, () => setNewTopic(""), "新专题")}
          {topicRows.map((t) => row("topic", t.id, { kind: "topic", id: t.id }, t.title, liveTasks.filter((x) => x.topicId === t.id).length, `scope-topic-${t.title}`))}
          {folded.topic && topicRows.length < liveTopics.length && (
            <button type="button" className="nav-more" onClick={() => fold("topic")}>
              还有 {liveTopics.length - topicRows.length} 个专题
            </button>
          )}
          {newTopic === null ? (
            !folded.topic && (
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
          {projectRows.map((w) => row("project", w.id, { kind: "workspace", id: w.id }, w.name, liveTasks.filter((t) => t.workspaceId === w.id).length, `scope-ws-${w.name}`, w.path))}
          {folded.project && projectRows.length < projects.length && (
            <button type="button" className="nav-more" onClick={() => fold("project")}>
              还有 {projects.length - projectRows.length} 个项目
            </button>
          )}
          <div className="add-ws">
            {!adding ? (
              !folded.project && (
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
    </nav>
  );
}
