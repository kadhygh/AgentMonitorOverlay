import { useEffect, useState } from "react";
import type { ModelProfile, ScheduleProposal, TodoItem, Workspace, WorkspaceActivity } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { mergeFirstLoad, onHostEvent, onHostReconnect } from "../host/events.js";
import { profileLabel } from "../lib/profiles.js";

/** Scheduler proposals waiting for the person, kept live. */
export function usePendingProposals(link: HostLink) {
  const [pending, setPending] = useState<readonly ScheduleProposal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = (first = false) =>
      call(link, "GET /api/proposals", {}, undefined, { state: "pending" })
        .then((list) => !cancelled && setPending((cur) => (first ? mergeFirstLoad(list, cur) : list)))
        .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type !== "proposal.upserted") return;
      setPending((cur) => {
        const rest = cur.filter((p) => p.id !== e.proposal.id);
        return e.proposal.state === "pending" ? [...rest, e.proposal] : rest;
      });
    });
    const offReconnect = onHostReconnect(() => void load());
    void load(true);
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link]);
  return pending;
}

/**
 * "调度提案" above the board: what the scheduler would start, for the person to approve (optionally after editing the
 * prompt or model) or reject. Nothing starts before "批准开工".
 */
export function ProposalsPanel({
  link,
  proposals,
  todos,
  workspaces,
  profiles,
  activity,
  onStarted,
}: {
  link: HostLink;
  proposals: readonly ScheduleProposal[];
  todos: readonly TodoItem[];
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  activity: ReadonlyMap<string, WorkspaceActivity>;
  onStarted(taskId: string, sessionId: string): void;
}) {
  if (!proposals.length) return null;
  return (
    <section className="proposals" aria-label="调度提案">
      <div className="anno-head">
        <span className="anno-title">调度提案</span>
        <span className="anno-count">{proposals.length}</span>
        <span className="pack-item-sub">批准后才会建任务并开始第一轮</span>
      </div>
      <div className="proposal-list">
        {proposals.map((p) => (
          <ProposalCard
            key={p.id}
            link={link}
            proposal={p}
            todo={todos.find((t) => t.id === p.todoId)}
            workspace={workspaces.find((w) => w.id === p.workspaceId)}
            profiles={profiles}
            idle={activity.get(p.workspaceId)?.idle ?? true}
            onStarted={onStarted}
          />
        ))}
      </div>
    </section>
  );
}

function ProposalCard({
  link,
  proposal,
  todo,
  workspace,
  profiles,
  idle,
  onStarted,
}: {
  link: HostLink;
  proposal: ScheduleProposal;
  todo: TodoItem | undefined;
  workspace: Workspace | undefined;
  profiles: readonly ModelProfile[];
  idle: boolean;
  onStarted(taskId: string, sessionId: string): void;
}) {
  const [prompt, setPrompt] = useState(proposal.prompt);
  const [profileId, setProfileId] = useState(proposal.profileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function decide(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      if (approve) {
        const r = await call(link, "POST /api/proposals/:id/approve", { id: proposal.id }, { prompt: prompt.trim(), profileId });
        onStarted(r.task.id, r.session.id);
      } else {
        await call(link, "POST /api/proposals/:id/reject", { id: proposal.id });
      }
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <div className="proposal-card" data-testid="proposal-card">
      <span className="pack-item-title">{todo?.text ?? "（待办已不存在）"}</span>
      <span className="pack-item-sub">
        在 {workspace?.name ?? "?"}
        {idle ? " · 现在空闲" : " · 现在忙碌"}
        {proposal.reason ? ` · ${proposal.reason}` : ""}
      </span>
      <textarea className="preset-text" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} aria-label="提案提示词" />
      <div className="composer-bar">
        <label className="inline-field">
          模型
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="提案模型">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
        </label>
        {error && <span className="form-error">{error}</span>}
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={() => void decide(false)} disabled={busy}>
          拒绝
        </button>
        <button type="button" className="btn-primary small" onClick={() => void decide(true)} disabled={busy || !prompt.trim()}>
          批准开工
        </button>
      </div>
    </div>
  );
}
