import { useEffect, useRef, useState } from "react";
import { taskProject, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { relativeTime } from "../lib/status.js";
import type { Scope } from "./Board.js";

// 已归档: archived tasks are never on the board; this lists the ones of the current scope (newest archived first) to
// open them — read-only, with 恢复任务 on their page.

export function inScopeArchived(task: Task, scope: Scope): boolean {
  if (!task.archivedAt) return false;
  if (scope.kind === "all") return true;
  if (scope.kind === "topic") return task.topicId === scope.id;
  return task.workspaceId === scope.id;
}

export function ArchivedTasks({ tasks, workspaces, topics, scope, onOpen }: { tasks: readonly Task[]; workspaces: readonly Workspace[]; topics: readonly Topic[]; scope: Scope; onOpen(t: Task): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const archived = tasks.filter((t) => inScopeArchived(t, scope)).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  const q = query.trim().toLowerCase();
  const shown = q ? archived.filter((t) => t.title.toLowerCase().includes(q)) : archived;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!archived.length) return null;
  return (
    <div className="archived-tasks" ref={box}>
      <button type="button" className="archived-open" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="archived-open">
        已归档 {archived.length}
      </button>
      {open && (
        <div className="archived-pop" role="dialog" aria-label="已归档的任务" data-testid="archived-list">
          {archived.length > 6 && <input className="field" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按名称筛选" aria-label="筛选已归档的任务" />}
          <div className="archived-rows">
            {shown.map((t) => {
              const project = scope.kind === "workspace" ? null : taskProject(t, workspaces)?.name;
              const topic = scope.kind === "topic" || !t.topicId ? null : topics.find((x) => x.id === t.topicId)?.title;
              return (
                <button
                  key={t.id}
                  type="button"
                  className="archived-row"
                  onClick={() => {
                    setOpen(false);
                    onOpen(t);
                  }}
                  data-testid="archived-task"
                >
                  <span className="archived-title">{t.title}</span>
                  <span className="archived-meta">{[project, topic ? `专题 ${topic}` : "", t.archivedAt ? `${relativeTime(t.archivedAt)}归档` : ""].filter(Boolean).join(" · ")}</span>
                </button>
              );
            })}
            {!shown.length && <span className="archived-empty">没有名称含「{query}」的任务。</span>}
          </div>
          <span className="archived-hint">打开后只能查看；在任务页点「恢复任务」可放回看板。</span>
        </div>
      )}
    </div>
  );
}
