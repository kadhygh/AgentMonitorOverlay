import { useEffect, useMemo, useState } from "react";
import type { CoworkChoice, CoworkHandoff, CoworkJoin, CoworkRoleChoices, ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import { defaultProfile, lastWorkspace, pickable, profileLabel, rememberProfile } from "../lib/profiles.js";
import { showToast } from "../lib/toast.js";

// 协作 (cowork, 2026-11-23, plans/cowork.md 第 4 步): the Studio end. A session is brought into a 协作 on AMO 中转 from its
// 「更多」 menu (拉进协作…); a line under its bar says which 协作 it is in, how its AI stands there (the state this Host
// reports), its drafts waiting in 中转, 在中转里打开 and 退出. What the 协作 sends comes into the conversation folded as
// one row (chat/OriginMessage.tsx). The whole 协作 is only seen in the 中转 client (the user, 11-23: 第一版只在中转客户端里看
// 协作全貌). 转到我的会话 from the 中转 client asks here which session takes the 子会话 (CoworkHandoffs).

export const COWORK_STATE: Record<CoworkJoin["state"], { mark: string; label: string; hint: string }> = {
  idle: { mark: "✓", label: "待命", hint: "有人 @ 它时马上送进这个会话" },
  busy: { mark: "◐", label: "处理中", hint: "正在跑一轮：@ 它的先排队，这一轮完了再送进来" },
  owner: { mark: "!", label: "等主人", hint: "在等你（审批、提问、草稿，或输入框里有字）：@ 它的先排队，你这边空下来再送进来" },
  offline: { mark: "○", label: "不在线", hint: "会话不在了或已归档" },
};

/** This computer's sessions in 协作, kept current. */
export function useCoworkJoined(link: HostLink | null): CoworkJoin[] {
  const [joined] = useLiveResource<CoworkJoin[]>(
    { load: link ? () => call(link, "GET /api/cowork/joined", {}) : null, initial: [], onEvent: (cur, e) => (e.type === "cowork.joined.changed" ? e.joined : cur) },
    [link],
  );
  return joined;
}

/** Under a session's bar: the 协作 it is in. */
export function CoworkBar({ link, session, joined, onError }: { link: HostLink; session: Session; joined: readonly CoworkJoin[]; onError(text: string): void }) {
  const mine = joined.filter((j) => j.sessionId === session.id);
  const [busy, setBusy] = useState(false);
  const [roleOf, setRoleOf] = useState<CoworkJoin | null>(null);
  if (!mine.length) return null;
  // 让主控现在看一遍 (2026-11-24): the patrol, now, with its whole 待处理 (it waits for the turn when one runs).
  const patrol = async () => {
    try {
      const r = await call(link, "POST /api/pending/patrol", {}, { sessionIds: [session.id] });
      showToast({ text: r.woke.length ? "已经把待处理送进这个会话。" : r.later.length ? "它这一轮做完就把待处理送进去。" : "它现在没有待处理。", testId: "cowork-patrolled" });
    } catch (err) {
      onError(err instanceof HostApiError ? err.message : String(err));
    }
  };
  const leave = async (j: CoworkJoin) => {
    setBusy(true);
    try {
      await call(link, "POST /api/cowork/leave", {}, { sessionId: session.id, coworkId: j.coworkId });
    } catch (err) {
      onError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // The line opens the 协作 in the AMO 中转 client (2026-11-23, 反向跳转): the Host starts it with --open=cowork:<id>. An
  // older client starts without going there; Studio cannot tell, so the notice does not promise it.
  const open = async (j: CoworkJoin) => {
    try {
      await call(link, "POST /api/cowork/open-in-relay", {}, { target: `cowork:${j.coworkId}` });
      showToast({ text: `正在 AMO 中转里打开协作「${j.coworkTitle}」。`, testId: "cowork-opened" });
    } catch (err) {
      onError(err instanceof HostApiError ? err.message : String(err));
    }
  };
  return (
    <div className="cowork-bar" data-testid="cowork-bar">
      {mine.map((j) => {
        const st = COWORK_STATE[j.state];
        return (
          <span key={j.coworkId} className="cowork-line" data-testid="cowork-line" data-state={j.state}>
            <span className="cowork-mark">协作</span>
            <button type="button" className="cowork-text cowork-open" title={`在 AMO 中转里打开这个协作（这个会话在里面显示为「${j.name}」）`} onClick={() => void open(j)} data-testid="cowork-open">
              「{j.coworkTitle}」{j.ended ? "（已结束）" : ""} · 这个会话的 AI：
              <span className={`cowork-state ${j.state}`} title={st.hint} data-testid="cowork-state">
                {st.mark} {st.label}
              </span>
              {j.queued > 0 && <span className="cowork-dim"> · 排队 {j.queued} 条</span>}
            </button>
            {j.matters && (
              <span className={`cowork-role${j.role ? "" : " unset"}`} title={roleHint(j)} data-testid="cowork-role">
                {roleText(j)}
              </span>
            )}
            {j.matters && j.role !== "worker" && (j.pending ?? 0) > 0 && (
              <span className="cowork-pending" title="它的待处理：@ 它的、在等它的事项、发给它的消息，还没标处理了的。Studio 每 2 分钟看一次，有变化才叫它。" data-testid="cowork-pending">
                待处理 {j.pending}
              </span>
            )}
            {j.matters && j.role !== "worker" && !j.ended && (
              <button type="button" className="btn-ghost small" title="让它现在把待处理看一遍（它在跑时，这一轮做完再送进去）" onClick={() => void patrol()} data-testid="cowork-patrol">
                现在看一遍
              </button>
            )}
            {j.matters && !j.ended && (
              <button type="button" className="btn-ghost small dim" title="改这个会话在协作里的角色：这一方的主控，或某件事项的执行" onClick={() => setRoleOf(j)} data-testid="cowork-role-change">
                {j.role ? "改角色" : "选角色"}
              </button>
            )}
            {j.drafts > 0 && (
              <span className="cowork-drafts" title="「AI 发起 @ 和提问」关着：AI 想 @ 人或开子会话时先存成草稿，在中转里发出或不发" data-testid="cowork-drafts">
                {j.drafts} 条草稿等你确认
              </span>
            )}
            <button type="button" className="btn-ghost small dim" disabled={busy} title="让这个会话离开协作：排队给它的消息不再送进来；以后可以再拉进来" onClick={() => void leave(j)} data-testid="cowork-leave">
              退出
            </button>
          </span>
        );
      })}
      {roleOf && <CoworkRoleDialog link={link} session={session} join={roleOf} onClose={() => setRoleOf(null)} />}
    </div>
  );
}

/** 「主控」「执行 · 事项 3」「未分角色」. */
function roleText(j: CoworkJoin): string {
  if (j.role === "lead") return "主控";
  if (j.role === "worker") return `执行${j.matter ? ` · 事项 ${j.matter.no}` : ""}`;
  return "未分角色";
}

function roleHint(j: CoworkJoin): string {
  if (j.role === "lead") return "这一方的主控：理流程、派活、和你沟通、改它负责的事项的状态。每一方一个。";
  if (j.role === "worker") return `执行会话：只管${j.matter ? `事项 ${j.matter.no}「${j.matter.title}」` : "一件事项"}，在里面贴技术事实，结果交回给主控。`;
  return "角色出现之前拉进来的：权限照旧。点「选角色」给它定成主控或某件事项的执行。";
}

/** The role picker (拉进协作 and 改角色): this side's 主控 (or who already is), or 执行 of one open 事项. */
function RolePicker({ choices, sessionId, role, matter, onRole, onMatter }: { choices: CoworkRoleChoices; sessionId: string; role: "lead" | "worker"; matter: string; onRole(r: "lead" | "worker"): void; onMatter(id: string): void }) {
  const leadTaken = !!choices.lead && choices.lead.sessionId !== sessionId;
  return (
    <div className="cowork-roles" role="radiogroup" aria-label="角色" data-testid="cowork-roles">
      <label className={`cowork-choice${role === "lead" ? " on" : ""}${leadTaken ? " off" : ""}`}>
        <input type="radio" name="cowork-role" checked={role === "lead"} disabled={leadTaken} onChange={() => onRole("lead")} data-testid="cowork-role-lead" />
        <span className="cowork-choice-text">
          <b>这一方的主控</b>
          <span className="cowork-dim">{leadTaken ? `你这一方已经有主控：${choices.lead!.name}。要换，先把它改成执行或让它退出。` : "理流程、派活、和你沟通、改事项状态。每一方一个。"}</span>
        </span>
      </label>
      <label className={`cowork-choice${role === "worker" ? " on" : ""}${choices.openMatters.length ? "" : " off"}`}>
        <input type="radio" name="cowork-role" checked={role === "worker"} disabled={!choices.openMatters.length} onChange={() => onRole("worker")} data-testid="cowork-role-worker" />
        <span className="cowork-choice-text">
          <b>一件事项的执行</b>
          <span className="cowork-dim">{choices.openMatters.length ? "只管这一件：在里面贴技术事实，结果交回给主控。" : "协作里还没有开着的事项。"}</span>
          {role === "worker" && choices.openMatters.length > 0 && (
            <select value={matter} onChange={(e) => onMatter(e.target.value)} aria-label="事项" data-testid="cowork-role-matter">
              {choices.openMatters.map((m) => (
                <option key={m.id} value={m.id}>
                  事项 {m.no}「{m.title}」· {m.status} · {m.side}
                </option>
              ))}
            </select>
          )}
        </span>
      </label>
    </div>
  );
}

/** Reads the role choices of a 协作 (null while loading or on a service without roles). */
function useRoleChoices(link: HostLink, coworkId: string): { choices: CoworkRoleChoices | null; error: string | null } {
  const [choices, setChoices] = useState<CoworkRoleChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChoices(null);
    setError(null);
    if (!coworkId) return;
    let alive = true;
    call(link, "GET /api/cowork/:id/roles", { id: coworkId }).then(
      (v) => alive && setChoices(v),
      (err: unknown) => alive && setError(err instanceof HostApiError ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [link, coworkId]);
  return { choices, error };
}

/** 改角色 / 选角色 of a session already in a 协作. */
function CoworkRoleDialog({ link, session, join, onClose }: { link: HostLink; session: Session; join: CoworkJoin; onClose(): void }) {
  const { choices, error: loadError } = useRoleChoices(link, join.coworkId);
  const [role, setRole] = useState<"lead" | "worker">(join.role === "worker" ? "worker" : "lead");
  const [matter, setMatter] = useState(join.matter?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!choices) return;
    if (role === "lead" && choices.lead && choices.lead.sessionId !== session.id && choices.openMatters.length) setRole("worker");
    if (!matter && choices.openMatters.length) setMatter(choices.openMatters[0]!.id);
  }, [choices]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/cowork/role", {}, { sessionId: session.id, coworkId: join.coworkId, role, ...(role === "worker" ? { matter } : {}) });
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal className="cowork-dialog" label="协作里的角色" testId="cowork-role-dialog" busy={busy} onClose={onClose}>
      <span className="modal-title">「{join.coworkTitle}」里的角色</span>
      <span className="settings-hint">改了之后，下一条消息会带上新的角色说明。</span>
      {!choices && !loadError && <span className="settings-hint">正在读协作…</span>}
      {choices && <RolePicker choices={choices} sessionId={session.id} role={role} matter={matter} onRole={setRole} onMatter={setMatter} />}
      {(error || loadError) && (
        <span className="form-error" role="alert">
          {error || loadError}
        </span>
      )}
      <div className="description-dialog-actions">
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-primary" disabled={busy || !choices || (role === "worker" && !matter)} onClick={() => void save()} data-testid="cowork-role-save">
          保存
        </button>
      </div>
    </Modal>
  );
}

/** 拉进协作…: pick one of the person's 协作 and the name the session goes by there. */
export function CoworkJoinDialog({ link, session, taskTitle, joined, onClose, onJoined }: { link: HostLink; session: Session; taskTitle: string; joined: readonly CoworkJoin[]; onClose(): void; onJoined(j: CoworkJoin): void }) {
  const [list, setList] = useState<{ me: string; coworks: CoworkChoice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [label, setLabel] = useState((session.title?.trim() || taskTitle || "会话").slice(0, 60));
  const [busy, setBusy] = useState(false);
  const inIt = useMemo(() => new Set(joined.filter((j) => j.sessionId === session.id).map((j) => j.coworkId)), [joined, session.id]);
  // 主控 or 执行 (2026-11-24): offered once a 协作 is picked, on a service with roles.
  const { choices } = useRoleChoices(link, pick);
  const [role, setRole] = useState<"lead" | "worker">("lead");
  const [matter, setMatter] = useState("");
  useEffect(() => {
    if (!choices?.matters) return;
    setRole(choices.lead && choices.openMatters.length ? "worker" : "lead");
    setMatter(choices.openMatters[0]?.id ?? "");
  }, [choices]);
  const roleNeeded = !!choices?.matters;
  const roleOk = !roleNeeded || (role === "lead" ? !choices!.lead : !!matter);
  useEffect(() => {
    let alive = true;
    call(link, "GET /api/cowork/coworks", {}).then(
      (v) => {
        if (!alive) return;
        setList(v);
        setPick((cur) => cur || v.coworks.find((c) => !c.ended && !inIt.has(c.id))?.id || "");
      },
      (err: unknown) => alive && setError(err instanceof HostApiError ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      onJoined(await call(link, "POST /api/cowork/join", {}, { sessionId: session.id, coworkId: pick, label: label.trim(), ...(roleNeeded ? { role, ...(role === "worker" ? { matter } : {}) } : {}) }));
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const chosen = list?.coworks.find((c) => c.id === pick);
  return (
    <Modal className="cowork-dialog" label="拉进协作" testId="cowork-join-dialog" busy={busy} onClose={onClose}>
      <span className="modal-title">拉进协作</span>
      <span className="settings-hint">把这个会话拉进你在 AMO 中转里参加的一个协作：它就能以你的 AI 的身份在里面回复、开事项、改事项，不用每次再问你；碰到合并 master、改已定的口径这类事，它会先开「等你确认」。有人 @ 它、或有事项在等它时才会送进这个会话，而且等这一轮做完、你没在打字时才送。</span>
      {!list && !error && <span className="settings-hint">正在读你的协作…</span>}
      {list && !list.coworks.length && <span className="settings-hint" data-testid="cowork-none">你还没有参加协作：先在 AMO 中转里发起一个，或请别人把你拉进去。</span>}
      {list && list.coworks.length > 0 && (
        <div className="cowork-choices" role="radiogroup" aria-label="协作">
          {list.coworks.map((c) => {
            const here = inIt.has(c.id);
            return (
              <label key={c.id} className={`cowork-choice${pick === c.id ? " on" : ""}${c.ended || here ? " off" : ""}`} data-testid="cowork-choice">
                <input type="radio" name="cowork" value={c.id} checked={pick === c.id} disabled={c.ended || here} onChange={() => setPick(c.id)} />
                <span className="cowork-choice-text">
                  <b>{c.title}</b>
                  {c.ended ? "（已结束）" : here ? "（已经在里面）" : ""}
                  <span className="cowork-dim">
                    {[c.members.join("、"), c.agents.length ? `${c.agents.length} 个 AI` : "", c.repo && `${c.repo}${c.branch ? ` · ${c.branch}` : ""}`].filter(Boolean).join(" · ")}
                  </span>
                  {c.goal.trim() && <span className="cowork-goal">{c.goal.trim()}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {choices?.matters && <RolePicker choices={choices} sessionId={session.id} role={role} matter={matter} onRole={setRole} onMatter={setMatter} />}
      {list && list.coworks.length > 0 && (
        <label className="cowork-label">
          <span>在协作里叫</span>
          <span className="cowork-name-preview">{list.me} 的 AI · </span>
          <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} aria-label="会话名" data-testid="cowork-label" />
        </label>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <div className="description-dialog-actions">
        {chosen && <span className="settings-hint">别人看到的是「{list!.me} 的 AI · {label.trim() || "会话"}」</span>}
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-primary" disabled={busy || !chosen || !label.trim() || !roleOk} onClick={() => void join()} data-testid="cowork-join">
          拉进协作
        </button>
      </div>
    </Modal>
  );
}

/**
 * 转到我的会话 (2026-11-23): the 中转 client on this computer handed a 子会话 to Studio; this asks which session takes it — one
 * of the person's (newest first) or a new task's — then the Host brings that session into the 协作 and gives it the 子会话
 * in full, and the workbench goes there. Comes forward when one arrives.
 */
export function CoworkHandoffs({ link, tasks, sessions, workspaces, profiles }: { link: HostLink; tasks: readonly Task[]; sessions: readonly Session[]; workspaces: readonly Workspace[]; profiles: readonly ModelProfile[] }) {
  const [handoffs] = useLiveResource<CoworkHandoff[]>(
    {
      load: () => call(link, "GET /api/cowork/handoffs", {}),
      initial: [],
      onEvent: (cur, e) => {
        if (e.type !== "cowork.handoffs.changed") return cur;
        if (e.added) void window.amo?.openInWorkbench?.({ show: true });
        return e.handoffs;
      },
    },
    [link],
  );
  const h = handoffs[0];
  if (!h) return null;
  return <HandoffDialog key={h.threadId} link={link} handoff={h} tasks={tasks} sessions={sessions} workspaces={workspaces} profiles={profiles} />;
}

function HandoffDialog({ link, handoff: h, tasks, sessions, workspaces, profiles }: { link: HostLink; handoff: CoworkHandoff; tasks: readonly Task[]; sessions: readonly Session[]; workspaces: readonly Workspace[]; profiles: readonly ModelProfile[] }) {
  const taskOf = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // The person's sessions that can take it: main sessions and branches of live tasks, here, newest first.
  const choices = useMemo(
    () =>
      sessions
        .filter((s) => s.kind !== "sub" && !s.archivedAt && s.writer !== "archived" && s.runtime !== "remote" && s.taskId && taskOf.get(s.taskId) && !taskOf.get(s.taskId)!.archivedAt && !taskOf.get(s.taskId)!.remote)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 30),
    [sessions, taskOf],
  );
  const live = workspaces.filter((w) => !w.archivedAt);
  // 开这一方的主控 (2026-11-24, h.lead): a task of its own by default — the 主控 runs the 协作 for days.
  const [mode, setMode] = useState<"session" | "new">(choices.length && !h.lead ? "session" : "new");
  const [sessionId, setSessionId] = useState(choices[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(() => live.find((w) => w.id === lastWorkspace())?.id ?? live[0]?.id ?? "");
  const [profileId, setProfileId] = useState(defaultProfile(profiles)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (what: "accept" | "dismiss") => {
    setBusy(true);
    setError(null);
    try {
      if (what === "dismiss") await call(link, "POST /api/cowork/handoff/dismiss", {}, { threadId: h.threadId });
      else {
        if (mode === "new") rememberProfile(profileId);
        await call(link, "POST /api/cowork/handoff/accept", {}, mode === "new" ? { threadId: h.threadId, newTask: { workspaceId, profileId } } : { threadId: h.threadId, sessionId });
      }
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const sessionText = (s: Session) => `${taskOf.get(s.taskId!)?.title || "未命名任务"} · ${s.title || "会话"}`;
  return (
    <Modal className="cowork-dialog" label={h.lead ? "开这一方的主控" : "转到我的会话"} testId="cowork-handoff-dialog" busy={busy} onClose={() => void act("dismiss")}>
      <span className="modal-title">{h.lead ? `在 Studio 里开「${h.coworkTitle}」这一方的主控` : "转到我的会话"}</span>
      <span className="settings-hint">
        {h.lead
          ? `你在 AMO 中转里要在这台电脑上开协作「${h.coworkTitle}」里你这一方的主控。选一个会话当主控（建议新开一个任务）：它会以主控加入协作，收到目标、已定的事和开着的事项；之后有人 @ 它、有事项在等它时，Studio 把待它处理的送进去。`
          : `你在 AMO 中转里把协作「${h.coworkTitle}」的子会话「${h.title}」（${h.from} 问 ${h.to}）转到了这里。选一个会话接手：它会被拉进这个协作，收到子会话的全文；你和它商量后，可以让它替你回复，也可以自己去回。`}
      </span>
      <div className="cowork-choices" role="radiogroup" aria-label="接手的会话">
        <label className={`cowork-choice${mode === "session" ? " on" : ""}${choices.length ? "" : " off"}`}>
          <input type="radio" name="handoff-mode" checked={mode === "session"} disabled={!choices.length} onChange={() => setMode("session")} data-testid="handoff-existing" />
          <span className="cowork-choice-text">
            <b>已有的会话</b>
            <select value={sessionId} disabled={mode !== "session" || !choices.length} onChange={(e) => setSessionId(e.target.value)} aria-label="会话" data-testid="handoff-session">
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionText(s)}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className={`cowork-choice${mode === "new" ? " on" : ""}`}>
          <input type="radio" name="handoff-mode" checked={mode === "new"} onChange={() => setMode("new")} data-testid="handoff-new" />
          <span className="cowork-choice-text">
            <b>新开一个任务</b>
            <span className="cowork-new-row">
              <select value={workspaceId} disabled={mode !== "new"} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="项目" data-testid="handoff-workspace">
                {live.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <select value={profileId} disabled={mode !== "new"} onChange={(e) => setProfileId(e.target.value)} aria-label="模型" data-testid="handoff-profile">
                {pickable(profiles, profileId).map((p) => (
                  <option key={p.id} value={p.id}>
                    {profileLabel(p)}
                  </option>
                ))}
              </select>
            </span>
          </span>
        </label>
      </div>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <div className="description-dialog-actions">
        <span className="spacer" />
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act("dismiss")} data-testid="handoff-dismiss">
          {h.lead ? "不开了" : "不转了"}
        </button>
        <button type="button" className="btn-primary" disabled={busy || (mode === "session" ? !sessionId : !workspaceId || !profileId)} onClick={() => void act("accept")} data-testid="handoff-accept">
          {h.lead ? "开主控" : "转过去"}
        </button>
      </div>
    </Modal>
  );
}
