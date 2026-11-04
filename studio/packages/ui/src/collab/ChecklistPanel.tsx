import type { ChecklistItem, Id, Session } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { upsertById, useLiveResource } from "../host/live.js";

/** Every checklist item (they are few: one list per templated task), kept live. */
export function useChecklist(link: HostLink) {
  const [items] = useLiveResource<readonly ChecklistItem[]>(
    { load: () => call(link, "GET /api/checklist"), initial: [], onEvent: (cur, e) => (e.type === "checklist.upserted" ? upsertById(cur, e.item) : cur) },
    [link],
  );
  return items;
}

/** Done/total per task, for the board cards. */
export function checklistByTask(items: readonly ChecklistItem[]): Map<Id, { done: number; total: number }> {
  const counts = new Map<Id, { done: number; total: number }>();
  for (const i of items) {
    const c = counts.get(i.taskId) ?? { done: 0, total: 0 };
    counts.set(i.taskId, { done: c.done + (i.done ? 1 : 0), total: c.total + 1 });
  }
  return counts;
}

/** "清单": the task's steps from its template. The person ticks them here; sessions tick theirs through the MCP. */
export function ChecklistPanel({ link, items, sessions }: { link: HostLink; items: readonly ChecklistItem[]; sessions: readonly Session[] }) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const done = sorted.filter((i) => i.done).length;
  const by = (i: ChecklistItem) => (i.doneBySessionId ? sessions.find((s) => s.id === i.doneBySessionId)?.title || "会话" : "我");
  return (
    <section className="mail-panel" aria-label="清单">
      <div className="anno-head">
        <span className="anno-title">清单</span>
        <span className="anno-count" data-testid="checklist-count">
          {done}/{sorted.length}
        </span>
      </div>
      {sorted.map((i) => (
        <label key={i.id} className={i.done ? "check-row done" : "check-row"} data-testid="checklist-item">
          <input type="checkbox" checked={i.done} onChange={(e) => void call(link, "PATCH /api/checklist/:id", { id: i.id }, { done: e.target.checked }).catch(() => undefined)} />
          <span className="check-text">{i.text}</span>
          {i.done && (
            <span className="check-by" title={by(i)}>
              {by(i)}
            </span>
          )}
        </label>
      ))}
    </section>
  );
}
