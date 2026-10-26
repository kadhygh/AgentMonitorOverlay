import { useEffect, useState } from "react";
import { isCommon, type ModelProfile, type PlannedTask, type Task, type TaskPlan, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { effortLabel } from "../lib/choices.js";

// 拆任务提案 (stage 16, from the stage 15 design): a 主控 proposes tasks; the person looks at them here, changes what
// they want, and accepts (立刻开跑 or 放进待办) or dismisses. Shown on the topic's canvas and on the 主控's task page.

/** The proposals the Host lists (open ones, and those decided in the last day), kept current. */
export function useTaskPlans(link: HostLink): TaskPlan[] {
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => call(link, "GET /api/task-plans", {}).then((p) => live && setPlans(p)).catch(() => undefined);
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "taskplan.upserted") setPlans((cur) => (cur.some((p) => p.id === e.plan.id) ? cur.map((p) => (p.id === e.plan.id ? e.plan : p)) : [...cur, e.plan]));
    });
    const offReconnect = onHostReconnect(() => void load());
    return () => {
      live = false;
      off();
      offReconnect();
    };
  }, [link]);
  return plans;
}

/** One line per open proposal: who proposed what; 查看 opens it. */
export function PlanBanner({ link, plans, tasks, workspaces, profiles }: { link: HostLink; plans: readonly TaskPlan[]; tasks: readonly Task[]; workspaces: readonly Workspace[]; profiles: readonly ModelProfile[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const waiting = plans.filter((p) => p.state === "open");
  const shown = open ? plans.find((p) => p.id === open && p.state === "open") : undefined;
  if (!waiting.length) return null;
  return (
    <>
      <div className="plan-banner" role="status" data-testid="plan-banner" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
        {waiting.map((p) => (
          <div key={p.id} className="plan-banner-row">
            <span className="plan-banner-mark">拆任务提案</span>
            <span className="plan-banner-text">
              主控「{tasks.find((t) => t.id === p.fromTaskId)?.title || "主控"}」提了 {p.tasks.length} 个任务：{p.summary.split("\n")[0]}
            </span>
            <button type="button" className="btn-primary small" onClick={() => setOpen(p.id)} data-testid="plan-open">
              查看
            </button>
          </div>
        ))}
      </div>
      {shown && <PlanDialog link={link} plan={shown} workspaces={workspaces} profiles={profiles} onClose={() => setOpen(null)} />}
    </>
  );
}

type Draft = PlannedTask & { include: boolean };

/** The proposal, editable: keep or drop each task, change its title, project, model, description and first message. */
export function PlanDialog({ link, plan, workspaces, profiles, onClose }: { link: HostLink; plan: TaskPlan; workspaces: readonly Workspace[]; profiles: readonly ModelProfile[]; onClose(): void }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => plan.tasks.map((t) => ({ ...t, include: true })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const projects = workspaces.filter((w) => !w.archivedAt);
  const models = profiles.filter((p) => !p.hidden && !p.unavailable);
  const change = (key: string, patch: Partial<Draft>) => setDrafts((cur) => cur.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const titleOf = (key: string) => drafts.find((d) => d.key === key)?.title ?? key;
  const kept = drafts.filter((d) => d.include).length;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const accept = (run: boolean) => act(() => call(link, "POST /api/task-plans/:id/accept", { id: plan.id }, { tasks: drafts, run }));
  const dismiss = () => act(() => call(link, "POST /api/task-plans/:id/dismiss", { id: plan.id }, dismissing?.trim() ? { note: dismissing.trim() } : {}));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plan-dialog" role="dialog" aria-modal="true" aria-label="拆任务提案" data-testid="plan-dialog">
        <span className="modal-title">拆任务提案</span>
        <p className="plan-summary">{plan.summary}</p>
        <div className="plan-tasks">
          {drafts.map((d) => (
            <div key={d.key} className={d.include ? "plan-task" : "plan-task dropped"} data-testid="plan-task">
              <div className="plan-task-head">
                <label className="plan-include" title="去掉的任务不会建">
                  <input type="checkbox" checked={d.include} onChange={(e) => change(d.key, { include: e.target.checked })} aria-label={`采用「${d.title}」`} />
                </label>
                <input className="field plan-title" aria-label="任务名" value={d.title} disabled={!d.include} onChange={(e) => change(d.key, { title: e.target.value })} />
                <select className="field plan-select" aria-label="项目" value={d.workspaceId} disabled={!d.include} onChange={(e) => change(d.key, { workspaceId: e.target.value })}>
                  {projects.map((w) => (
                    <option key={w.id} value={w.id}>
                      {isCommon(w) ? "未指定项目" : w.name}
                    </option>
                  ))}
                </select>
                <select className="field plan-select" aria-label="模型" value={d.profileId ?? ""} disabled={!d.include} onChange={(e) => change(d.key, { profileId: e.target.value })}>
                  {models.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* The proposed model and effort, while the proposed account stays (another account: its defaults). */}
              {d.options && d.profileId === plan.tasks.find((t) => t.key === d.key)?.profileId && (
                <span className="plan-deps" data-testid="plan-options">
                  {[d.options.model ? `型号 ${d.options.model}` : "", d.options.effort ? `思考强度 ${effortLabel(d.options.effort)}` : ""].filter(Boolean).join(" · ")}
                </span>
              )}
              {d.dependsOn.length > 0 && <span className="plan-deps">依赖：{d.dependsOn.map(titleOf).join("、")}</span>}
              {d.include && (
                <>
                  <label className="plan-field">
                    <span className="plan-lab">说明</span>
                    <textarea className="side-textarea plan-text" aria-label="说明" rows={2} placeholder="显示在画布卡片上" value={d.description ?? ""} onChange={(e) => change(d.key, { description: e.target.value })} />
                  </label>
                  <label className="plan-field">
                    <span className="plan-lab">第一句话</span>
                    <textarea className="side-textarea plan-text" aria-label="第一句话" rows={3} placeholder="立刻开跑时发给它的会话" value={d.firstMessage ?? ""} onChange={(e) => change(d.key, { firstMessage: e.target.value })} />
                  </label>
                </>
              )}
            </div>
          ))}
        </div>
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        {dismissing !== null ? (
          <div className="plan-actions">
            <input className="field plan-note" aria-label="不采用的原因" placeholder="告诉主控为什么（可以不写）" value={dismissing} autoFocus onChange={(e) => setDismissing(e.target.value)} />
            <button type="button" className="btn-ghost" onClick={() => setDismissing(null)}>
              返回
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void dismiss()} data-testid="plan-dismiss-confirm">
              不采用
            </button>
          </div>
        ) : (
          <div className="plan-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setDismissing("")} data-testid="plan-dismiss">
              不采用…
            </button>
            <span className="spacer" />
            <span className="settings-hint">建 {kept} 个任务，放上画布并连好依赖</span>
            <button type="button" className="btn-ghost" disabled={busy || !kept} title="建好任务，放在待办里，等你开始" onClick={() => void accept(false)} data-testid="plan-accept-todo">
              放进待办
            </button>
            <button type="button" className="btn-primary" disabled={busy || !kept} title="建好任务，每个都用第一句话开跑" onClick={() => void accept(true)} data-testid="plan-accept-run">
              立刻开跑
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
