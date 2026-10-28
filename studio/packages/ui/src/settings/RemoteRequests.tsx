import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isCommon, peerPresence, REMOTE_PERMISSION_LABEL, RUNTIME_LABELS, type ModelProfile, type RemotePeer, type RemoteState, type RemoteTaskRequest, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { relativeTime } from "../lib/status.js";

// 远程 step 4 (2026-10-29, plans/remote-session.md 方式 2): B asks one of the person's other computers (A) to run a task;
// A's person picks where it goes and the model, and allows or refuses it. On B: 「请它跑一个任务…」 on a paired device
// that allowed this computer, and the requests sent to it (等它同意 / 拒绝了 / 同意了). On A: the requests to answer.

function Dialog({ title, testId, busy, onClose, children }: { title: string; testId: string; busy: boolean; onClose(): void; children: ReactNode }) {
  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!busy) onClose();
        }
      }}
    >
      <div className="modal confirm-modal remote-request-modal" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <span className="modal-title">{title}</span>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

/** On B: what to ask a device to run — a title and the first message. */
export function AskDialog({ link, peer, onClose, onDone }: { link: HostLink; peer: RemotePeer; onClose(): void; onDone(text: string): void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/remote/asks", {}, { account: peer.account, device: peer.device, title, text });
      onDone(`已发给 ${peer.name}，等它同意`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }
  return (
    <Dialog title={`请「${peer.name}」帮忙跑一个任务`} testId="remote-ask-dialog" busy={busy} onClose={onClose}>
      <label className="remote-request-field">
        <span className="settings-label">标题</span>
        <input ref={first} className="field" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="比如：整理掉落表的说明" data-testid="remote-ask-title" />
      </label>
      <label className="remote-request-field">
        <span className="settings-label">要做的事</span>
        <textarea className="field" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="会作为任务的第一句话，发给那边新开的会话" data-testid="remote-ask-text" />
      </label>
      <ul className="confirm-risks">
        <li>{peer.name} 那边的人决定放在哪个项目、哪个专题、用哪个模型；同意后这个任务出现在这台电脑的看板上，会话在那台电脑上跑。</li>
        <li>只在 {peer.name} 在线时能发：团队服务器不替你存请求。发出后等它同意之前可以撤回。</li>
      </ul>
      {error && (
        <span className="form-error" role="alert" data-testid="remote-ask-error">
          {error}
        </span>
      )}
      <div className="settings-row end">
        <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary small" onClick={() => void send()} disabled={busy || !title.trim() || !text.trim()} data-testid="remote-ask-send">
          发送请求
        </button>
      </div>
    </Dialog>
  );
}

/** On B: the requests sent to one device, under its card. */
export function PeerAsks({ peer, asks, busy, onAsk, onWithdraw }: { peer: RemotePeer; asks: readonly RemoteTaskRequest[]; busy: boolean; onAsk(): void; onWithdraw(r: RemoteTaskRequest): void }) {
  const online = peerPresence(peer) === "online";
  const mine = asks.filter((r) => r.account === peer.account && r.device === peer.device);
  return (
    <>
      {mine.map((r) => (
        <div key={r.id} className="settings-row remote-outgoing" data-testid="remote-ask" data-state={r.state}>
          <span className={r.state === "refused" ? "settings-hint remote-ask-refused" : "settings-hint"}>
            {r.state === "pending"
              ? `等 ${peer.name} 同意 ·「${r.title}」· ${relativeTime(r.createdAt)}发出`
              : r.state === "refused"
                ? `${peer.name} 拒绝了「${r.title}」${r.reason ? `：${r.reason}` : "（没写原因）"}`
                : `${peer.name} 同意了「${r.title}」，任务已经在看板上`}
          </span>
          <span className="spacer" />
          <button type="button" className="btn-ghost small" disabled={busy} title={r.state === "pending" ? (online ? "撤回这个请求" : `${peer.name} 不在线，撤回要等它在线`) : undefined} onClick={() => onWithdraw(r)} data-testid="remote-ask-withdraw">
            {r.state === "pending" ? "撤回" : "知道了"}
          </button>
        </div>
      ))}
      <div className="settings-row">
        <span className="spacer" />
        <button type="button" className="btn-ghost small" disabled={busy || !online} title={online ? `写清要做什么，${peer.name} 同意后在那边建任务开跑，这台电脑的看板上能看到` : `${peer.name} 不在线：请求要它在线时才能发（团队服务器不替你存请求）`} onClick={onAsk} data-testid="remote-ask-open">
          请它跑一个任务…
        </button>
      </div>
    </>
  );
}

/** On A: the requests to answer, with 同意… (where it goes, the model) and 拒绝… (why). */
export function IncomingTaskRequests({
  link,
  remote,
  workspaces,
  topics,
  profiles,
  busy,
  run,
}: {
  link: HostLink;
  remote: RemoteState;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  profiles: readonly ModelProfile[];
  busy: boolean;
  run(fn: () => Promise<unknown>, done?: string): Promise<void>;
}) {
  const [accepting, setAccepting] = useState<RemoteTaskRequest | null>(null);
  const [refusing, setRefusing] = useState<RemoteTaskRequest | null>(null);
  const [reason, setReason] = useState("");
  if (!remote.taskRequests.length) return null;
  return (
    <section className="settings-section" aria-label="请这台电脑跑的任务" data-testid="remote-task-requests">
      <span className="settings-heading">请这台电脑跑的任务</span>
      {remote.taskRequests.map((r) => (
        <div key={r.id} className="remote-card attention" data-testid="remote-task-request">
          <span className="remote-card-title">
            {r.name}（{r.account}）请这台电脑跑：「{r.title}」
          </span>
          <span className="settings-hint remote-request-text">{r.text}</span>
          <span className="settings-hint">{relativeTime(r.createdAt)}发来 · 同意后在这台电脑上建任务、开会话，并授权给 {r.name}。</span>
          <div className="settings-row end">
            <button
              type="button"
              className="btn-ghost small"
              disabled={busy}
              onClick={() => {
                setReason("");
                setRefusing(r);
              }}
              data-testid="remote-task-refuse"
            >
              拒绝…
            </button>
            <button type="button" className="btn-primary small" disabled={busy} onClick={() => setAccepting(r)} data-testid="remote-task-accept">
              同意…
            </button>
          </div>
        </div>
      ))}
      {accepting && (
        <AcceptDialog
          link={link}
          request={accepting}
          remote={remote}
          workspaces={workspaces}
          topics={topics}
          profiles={profiles}
          onClose={() => setAccepting(null)}
          onDone={(text) => {
            setAccepting(null);
            void run(() => Promise.resolve(), text);
          }}
        />
      )}
      {refusing && (
        <Dialog title={`拒绝 ${refusing.name} 的请求「${refusing.title}」？`} testId="remote-refuse-dialog" busy={busy} onClose={() => setRefusing(null)}>
          <label className="remote-request-field">
            <span className="settings-label">原因</span>
            <textarea className="field" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="可以不写；写了对方会看到" data-testid="remote-refuse-reason" />
          </label>
          <div className="settings-row end">
            <button type="button" className="btn-ghost small" onClick={() => setRefusing(null)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn-danger small"
              disabled={busy}
              onClick={() => {
                const r = refusing;
                void run(() => call(link, "POST /api/remote/task-requests/:id/refuse", { id: r.id }, { reason }), `已拒绝 ${r.name} 的请求`).then(() => setRefusing(null));
              }}
              data-testid="remote-refuse-confirm"
            >
              拒绝
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

const profileLabel = (p: ModelProfile) => `${RUNTIME_LABELS[p.runtime]} · ${p.label}`;

/** On A: where an allowed request's task goes and the model its session runs on (only 远端允许的模型). */
function AcceptDialog({
  link,
  request,
  remote,
  workspaces,
  topics,
  profiles,
  onClose,
  onDone,
}: {
  link: HostLink;
  request: RemoteTaskRequest;
  remote: RemoteState;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  profiles: readonly ModelProfile[];
  onClose(): void;
  onDone(text: string): void;
}) {
  const places = workspaces.filter((w) => !w.archivedAt);
  const common = places.find(isCommon);
  const models = remote.allowed.profiles.flatMap((id) => {
    const p = profiles.find((x) => x.id === id);
    return p && !p.unavailable ? [p] : [];
  });
  const [workspaceId, setWorkspaceId] = useState(common?.id ?? places[0]?.id ?? "");
  const [topicId, setTopicId] = useState("");
  const [profileId, setProfileId] = useState(remote.allowed.defaultProfile && models.some((m) => m.id === remote.allowed.defaultProfile) ? remote.allowed.defaultProfile : (models[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/remote/task-requests/:id/accept", { id: request.id }, { workspaceId, topicId: topicId || null, profileId });
      onDone(`已同意：「${request.title}」开始跑了，${request.name} 那边能看到`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }
  const permission = remote.allowed.permission ? REMOTE_PERMISSION_LABEL[remote.allowed.permission] : "模型自己的默认";
  return (
    <Dialog title={`同意 ${request.name} 的请求「${request.title}」`} testId="remote-accept-dialog" busy={busy} onClose={onClose}>
      <span className="settings-hint remote-request-text">{request.text}</span>
      <label className="remote-request-field">
        <span className="settings-label">项目</span>
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} data-testid="remote-accept-workspace">
          {places.map((w) => (
            <option key={w.id} value={w.id}>
              {isCommon(w) ? "公共目录（不属于任何项目）" : w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="remote-request-field">
        <span className="settings-label">专题</span>
        <select value={topicId} onChange={(e) => setTopicId(e.target.value)} data-testid="remote-accept-topic">
          <option value="">不放进专题</option>
          {topics
            .filter((t) => !t.archivedAt)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
        </select>
      </label>
      <label className="remote-request-field">
        <span className="settings-label">模型</span>
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={!models.length} data-testid="remote-accept-model">
          {models.map((p) => (
            <option key={p.id} value={p.id}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
      </label>
      {!models.length && (
        <span className="form-error" data-testid="remote-accept-no-model">
          还没有选远端允许的模型：先关掉这个对话框，在下面「远端允许的模型」里勾上可以给远程任务用的模型并保存。
        </span>
      )}
      <ul className="confirm-risks">
        <li>建任务「{request.title}」（说明就是请求的内容），授权给 {request.name}，用选的模型开会话，把请求的内容作为第一句话发出。</li>
        <li>会话的权限：{permission}（在下面「远端允许的模型」里改）。命令以这台电脑上你的用户身份运行，用的是这台电脑的模型账号。</li>
      </ul>
      {error && (
        <span className="form-error" role="alert" data-testid="remote-accept-error">
          {error}
        </span>
      )}
      <div className="settings-row end">
        <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary small" onClick={() => void accept()} disabled={busy || !workspaceId || !profileId} data-testid="remote-accept-confirm">
          同意并开始
        </button>
      </div>
    </Dialog>
  );
}
