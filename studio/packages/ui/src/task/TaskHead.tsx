import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isCommon, TASK_COLUMNS, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { COLUMN_NAMES } from "../lib/status.js";

// The task page's head (2026-10-14, 方案 A): the title, and under it one quiet line of what the task is — status,
// project, branch, topic — each a word that opens its own small picker. No boxes until hovered.

/** The status colours of the line under the title (the board's columns). */
const STATUS_DOT: Record<TaskColumn, string> = { todo: "var(--muted-dot)", doing: "var(--running)", review: "var(--attention)", done: "var(--text-dim)" };

/** The current branch of a git project, asked again when the window comes back (it changes outside Studio). */
export function useGitBranch(link: HostLink, workspaceId: string | null | undefined): { repo: boolean; branch: string | null } {
  const [state, setState] = useState<{ repo: boolean; branch: string | null }>({ repo: false, branch: null });
  useEffect(() => {
    setState({ repo: false, branch: null });
    if (!workspaceId || !link.url) return;
    let live = true;
    const load = () =>
      void call(link, "GET /api/workspaces/:id/git/status", { id: workspaceId })
        .then((s) => live && setState({ repo: s.repo, branch: s.repo ? (s.branch ?? (s.head ? `${s.head.slice(0, 7)}（分离）` : null)) : null }))
        .catch(() => undefined);
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [link, workspaceId]);
  return state;
}

/** Closes on Escape and on a press outside `.ctx-menu` / the picker. */
function useDismiss(onClose: () => void, inside = ".ctx-menu") {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(inside) && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose, inside]);
}

/** Where a popover opens: under the element that opened it. */
export type Anchor = { x: number; y: number };
export const below = (el: HTMLElement): Anchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};

/** A small menu under its button (⋯ menus of the task and the session). */
export function PopMenu({ at, label, onClose, children, testId }: { at: Anchor; label: string; onClose(): void; children: ReactNode; testId?: string }) {
  useDismiss(onClose);
  return (
    <div className="ctx-menu" role="menu" aria-label={label} style={{ left: Math.min(at.x, window.innerWidth - 200), top: at.y }} data-testid={testId}>
      {children}
    </div>
  );
}

/** 改状态: the four columns, also by 1–4 while open. */
export function StatusMenu({ at, value, onPick, onClose }: { at: Anchor; value: TaskColumn; onPick(c: TaskColumn): void; onClose(): void }) {
  useDismiss(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = Number(e.key) - 1;
      if (i >= 0 && i < TASK_COLUMNS.length) {
        e.preventDefault();
        onPick(TASK_COLUMNS[i]!);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPick, onClose]);
  return (
    <div className="ctx-menu status-menu" role="menu" aria-label="任务状态" style={{ left: at.x, top: at.y }} data-testid="status-menu">
      {TASK_COLUMNS.map((c, i) => (
        <button
          key={c}
          type="button"
          role="menuitemradio"
          aria-checked={c === value}
          autoFocus={c === value}
          onClick={() => {
            onPick(c);
            onClose();
          }}
          data-testid={`status-${c}`}
        >
          <span className="meta-dot" style={{ background: STATUS_DOT[c] }} />
          {COLUMN_NAMES[c]}
          <kbd>{i + 1}</kbd>
        </button>
      ))}
    </div>
  );
}

/** 换专题: a search box over the topics (as 找文件); 「—」 takes the task out; a name that matches none makes a topic. */
export function TopicPicker({ topics, tasks, current, onPick, onCreate, onClose }: { topics: readonly Topic[]; tasks: readonly Task[]; current: string | null; onPick(id: string | null): void; onCreate(title: string): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [hl, setHl] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  type Row = { kind: "none" } | { kind: "topic"; topic: Topic } | { kind: "new"; title: string };
  const rows = useMemo<Row[]>(() => {
    const live = topics.filter((t) => !t.archivedAt && (!q || t.title.toLowerCase().includes(q)));
    const out: Row[] = [];
    if (!q) out.push({ kind: "none" });
    out.push(...live.map((topic) => ({ kind: "topic" as const, topic })));
    if (q && !topics.some((t) => !t.archivedAt && t.title.toLowerCase() === q)) out.push({ kind: "new", title: query.trim() });
    return out;
  }, [topics, q, query]);
  useEffect(() => setHl(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${hl}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hl]);
  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === "none") onPick(null);
    else if (r.kind === "topic") onPick(r.topic.id);
    else onCreate(r.title);
    onClose();
  };
  const count = (id: string) => tasks.filter((t) => t.topicId === id && !t.archivedAt).length;
  return (
    <div className="file-picker-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="file-picker topic-picker" role="dialog" aria-label="选择专题" data-testid="topic-picker">
        <input
          className="file-picker-input"
          autoFocus
          value={query}
          placeholder="搜索专题，或输入新专题的名字"
          aria-label="搜索专题"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (rows.length) setHl((h) => (h + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(rows[hl]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="file-picker-list" role="listbox" aria-label="专题" ref={list}>
          {rows.map((r, i) => (
            <button
              key={r.kind === "topic" ? r.topic.id : r.kind}
              type="button"
              role="option"
              data-index={i}
              aria-selected={i === hl}
              className={i === hl ? "hl" : undefined}
              onMouseMove={() => setHl(i)}
              onClick={() => choose(r)}
              data-testid="topic-option"
            >
              {r.kind === "none" && (
                <>
                  <span className="topic-mark dim">—</span>
                  <span className="topic-name">不放进专题</span>
                  {current === null && <span className="file-row-meta">当前</span>}
                </>
              )}
              {r.kind === "topic" && (
                <>
                  <span className="topic-mark">#</span>
                  <span className="topic-name">{r.topic.title}</span>
                  <span className="file-row-meta">{r.topic.id === current ? "当前" : `${count(r.topic.id)} 个任务`}</span>
                </>
              )}
              {r.kind === "new" && (
                <>
                  <span className="topic-mark">+</span>
                  <span className="topic-name">新建专题「{r.title}」并放进去</span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="file-picker-foot">
          <span>↑↓ 选择 · 回车确定 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

const Icon = {
  folder: (
    <svg className="meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
    </svg>
  ),
  branch: (
    <svg className="meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="4" r="1.6" />
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="11" cy="6" r="1.6" />
      <path d="M5 5.6v4.8M11 7.6c0 2-3 2-5.4 3" />
    </svg>
  ),
  topic: (
    <svg className="meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 5h10M3 8h10M3 11h6" />
    </svg>
  ),
};

/**
 * The line under the title (方案 A1): `● 进行中 · 📁 项目 · ⎇ 分支 · ☰ 专题`, separated by dots. Each part is a button
 * that looks like text until hovered.
 */
export function TaskMeta({
  task,
  workspace,
  topic,
  branch,
  disabled,
  onStatus,
  onProject,
  onBranch,
  onTopic,
}: {
  task: Task;
  workspace: Workspace | undefined;
  topic: Topic | undefined;
  branch: string | null;
  disabled: boolean;
  onStatus(at: Anchor): void;
  onProject(): void;
  onBranch(): void;
  onTopic(): void;
}) {
  const parts: ReactNode[] = [
    <button key="status" type="button" className="meta-item status" disabled={disabled} title="改状态" aria-label={`状态：${COLUMN_NAMES[task.column]}`} onClick={(e) => onStatus(below(e.currentTarget))} data-testid="task-status">
      <span className="meta-dot" style={{ background: STATUS_DOT[task.column] }} />
      {COLUMN_NAMES[task.column]}
    </button>,
  ];
  if (workspace && !isCommon(workspace))
    parts.push(
      <button key="project" type="button" className="meta-item" aria-label={`项目：${workspace.name}`} title={`${workspace.path}${workspace.description ? `\n${workspace.description}` : ""}\n点击编辑项目名和说明`} onClick={onProject} data-testid="task-project">
        {Icon.folder}
        {workspace.name}
      </button>,
    );
  else
    parts.push(
      <span key="project" className="meta-item static" title={workspace ? `在公共目录里运行：${workspace.path}` : undefined}>
        {Icon.folder}未指定项目
      </span>,
    );
  if (branch)
    parts.push(
      <button key="branch" type="button" className="meta-item mono" aria-label={`分支：${branch}`} title="当前分支；点击看提交历史" onClick={onBranch} data-testid="task-branch">
        {Icon.branch}
        {branch}
      </button>,
    );
  parts.push(
    <button key="topic" type="button" className="meta-item" disabled={disabled} aria-label={topic ? `专题：${topic.title}` : "专题：无"} title={topic ? `专题：${topic.title}；点击换专题` : "不在专题里；点击放进专题"} onClick={onTopic} data-testid="task-topic">
      {Icon.topic}
      {topic ? topic.title : "—"}
    </button>,
  );
  return (
    <div className="task-meta" data-testid="task-meta">
      {parts.flatMap((p, i) => (i ? [<span key={`sep${i}`} className="meta-sep" aria-hidden="true">·</span>, p] : [p]))}
    </div>
  );
}
