import { useState } from "react";
import type { DutyState, Id, StateSnapshot } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { actionText, runMark, scheduleText, when, type DutyCtx } from "../settings/DutyPage.js";
import { dutyTree, setDuty, useDuty } from "./duty.js";
import { Modal } from "../lib/Modal.js";

// 值守 from the top bar (2026-10-31, the user: 「studio里应该需要一个查看duty的界面」): what is on, what each did last and
// when it runs next, with the tasks and sessions it opened a click away. Turning an item on or off and 立即运行 are here;
// making and changing items stay in 设置 → 值守 (its form is big).

export function DutyDialog({ link, state, onClose, onOpenTask, onSettings }: { link: HostLink; state: StateSnapshot; onClose(): void; onOpenTask(taskId: Id, sessionId?: Id): void; onSettings(): void }) {
  const duty = useDuty();
  const [error, setError] = useState<string | null>(null);
  const ctx: DutyCtx = { profiles: state.profiles.filter((p) => !p.hidden && p.runtime !== "remote"), snapshot: state, builtins: duty?.builtins ?? [], checks: duty?.checks ?? [] };
  const act = (run: () => Promise<DutyState>) => {
    setError(null);
    run().then(setDuty, (err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
  };
  const live = (id: Id | null | undefined) => !!id && state.tasks.some((t) => t.id === id && !t.archivedAt);
  // On first, then the rest; each group as saved; children right under their parent.
  const items = dutyTree(duty?.items ?? [], (a, b) => Number(b.enabled) - Number(a.enabled));

  return (
    <Modal portal className="duty-dialog" label="值守" testId="duty-dialog" onClose={onClose}>
      <div className="modal-head">
        <span className="modal-title">值守</span>
        <span className="spacer" />
        <button type="button" className="link-btn" onClick={onSettings} data-testid="duty-dialog-settings">
          新建、编辑在设置里
        </button>
        <button type="button" className="link-btn" onClick={onClose} aria-label="关闭值守">
          关闭
        </button>
      </div>
      {!duty ? (
        <span className="settings-hint">读取中…</span>
      ) : items.length === 0 ? (
        <span className="settings-hint">还没有值守项。在 设置 → 值守 里建，或者让 AI 用「开始维护」这类模板建。</span>
      ) : (
        <ul className="duty-list">
          {items.map(({ item, parent }) => {
            const run = duty.runs.find((r) => r.itemId === item.id);
            const running = duty.running.includes(item.id);
            const taskId = item.action.kind === "session" ? item.action.taskId : null;
            const held = !!parent && !parent.enabled && !item.enabled;
            return (
              <li key={item.id} className={`duty-item${parent ? " duty-child" : ""}`} data-testid="duty-dialog-item" data-enabled={item.enabled} data-parent={parent?.id}>
                <div className="duty-item-head">
                  <label className="duty-toggle" title={held ? `挂在「${parent!.title}」下面，先开「${parent!.title}」` : undefined}>
                    <input type="checkbox" checked={item.enabled} disabled={held} onChange={(e) => act(() => call(link, "PATCH /api/duty/items/:id", { id: item.id }, { enabled: e.target.checked }))} aria-label={`开启「${item.title}」`} />
                    <b>{item.title}</b>
                  </label>
                  {parent && <span className="settings-tag" title="父值守关掉时它也跟着关">挂在「{parent.title}」下</span>}
                  {item.builtin && <span className="settings-tag">Studio 自带</span>}
                  {item.by === "agent" && <span className="settings-tag" title="AI 用 duty_save 建的或最后改的（你批准过）">AI 建的</span>}
                  <span className="settings-hint">{scheduleText(item.schedule)}</span>
                  <span className="grow" />
                  {live(taskId) && (
                    <button type="button" className="btn-ghost small" onClick={() => onOpenTask(taskId!)}>
                      打开任务
                    </button>
                  )}
                  {item.setBy && live(state.sessions.find((s) => s.id === item.setBy)?.taskId) && (
                    <button type="button" className="btn-ghost small" title="用 duty_save 设这一项的会话" onClick={() => onOpenTask(state.sessions.find((s) => s.id === item.setBy)!.taskId!, item.setBy)}>
                      设它的会话
                    </button>
                  )}
                  <button type="button" className="btn-ghost small" disabled={running} onClick={() => act(() => call(link, "POST /api/duty/items/:id/run", { id: item.id }))}>
                    立即运行
                  </button>
                </div>
                <div className="settings-hint">{actionText(item.action, ctx)}</div>
                <div className="duty-run">
                  <span className={`duty-mark ${running || run?.ok === null ? "on" : run?.ok === false && !run.skipped ? "bad" : ""}`}>{runMark(run, running)}</span>
                  {run && (
                    <span>
                      {when(run.startedAt)}
                      {run.summary && run.ok !== null ? ` · ${run.summary}` : running && run.summary ? ` · ${run.summary}` : ""}
                    </span>
                  )}
                  {run?.sessionId && live(run.taskId) && (
                    <button type="button" className="link-btn" onClick={() => onOpenTask(run.taskId!, run.sessionId)} data-testid="duty-dialog-session">
                      看它开的会话
                    </button>
                  )}
                  {item.enabled && duty.next[item.id] && !running && <span className="settings-hint">下次 {when(duty.next[item.id])}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <span className="settings-hint error">{error}</span>}
    </Modal>
  );
}
