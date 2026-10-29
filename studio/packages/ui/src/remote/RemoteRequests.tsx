import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isCommon, peerPresence, REMOTE_PERMISSION_LABEL, RUNTIME_LABELS, type ModelProfile, type RemotePeer, type RemoteState, type RemoteTaskRequest, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { relativeTime } from "../lib/status.js";

// 远程 step 4 (2026-10-29, plans/remote-session.md 方式 2): B asks one of the person's other computers (A) to run a task;
// A's person picks where it goes and the model, and allows or refuses it. On B: the requests sent (等它同意 / 拒绝了 /
// 同意了) under the remote page's 「在别的设备上跑的」. On A: the requests to answer, under 「等你处理」. Since 远程创建
// (2026-10-29) a new B creates tasks on A from its new-task page instead (no yes on A, 远端允许的项目 limits it), so
// the request dialog is gone; A still answers requests from an older B here, and B keeps showing what it sent before.

export function Dialog({ title, testId, busy, onClose, children, head, className = "" }: { title: string; testId: string; busy: boolean; onClose(): void; children: ReactNode; /** Beside the title, on the right. */ head?: ReactNode; className?: string }) {
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
      <div className={`modal confirm-modal remote-request-modal ${className}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        {head ? (
          <div className="remote-dialog-head">
            <span className="modal-title">{title}</span>
            <span className="spacer" />
            {head}
          </div>
        ) : (
          <span className="modal-title">{title}</span>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

/** On B: the requests this computer sent (the remote page's 「在别的设备上跑的」), with 撤回 / 知道了. */
export function AskRows({ asks, peers, busy, onWithdraw }: { asks: readonly RemoteTaskRequest[]; peers: readonly RemotePeer[]; busy: boolean; onWithdraw(r: RemoteTaskRequest): void }) {
  return (
    <>
      {asks.map((r) => {
        const peer = peers.find((p) => p.account === r.account && p.device === r.device && p.role === "guest");
        const name = peer?.name ?? r.name;
        const online = !!peer && peerPresence(peer) === "online";
        return (
          <div key={r.id} className="remote-row" data-testid="remote-ask" data-state={r.state} data-device={name}>
            <span className={r.state === "refused" ? "remote-row-main remote-ask-refused" : "remote-row-main"}>
              {r.state === "pending"
                ? `等 ${name} 同意 ·「${r.title}」· ${relativeTime(r.createdAt)}发出`
                : r.state === "refused"
                  ? `${name} 拒绝了「${r.title}」${r.reason ? `：${r.reason}` : "（没写原因）"}`
                  : `${name} 同意了「${r.title}」，任务已经在看板上`}
            </span>
            <button type="button" className="btn-ghost small" disabled={busy} title={r.state === "pending" ? (online ? "撤回这个请求" : `${name} 不在线，撤回要等它在线`) : undefined} onClick={() => onWithdraw(r)} data-testid="remote-ask-withdraw">
              {r.state === "pending" ? "撤回" : "知道了"}
            </button>
          </div>
        );
      })}
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
    <div className="remote-cards" aria-label="请这台电脑跑的任务" data-testid="remote-task-requests">
      {remote.taskRequests.map((r) => (
        <div key={r.id} className="remote-card attention" data-testid="remote-task-request">
          <span className="remote-card-title">
            {r.preset ? `${r.name}（${r.account}）想在这台电脑上建任务：「${r.title}」` : `${r.name}（${r.account}）请这台电脑跑：「${r.title}」`}
          </span>
          <span className="settings-hint remote-request-text">{r.text}</span>
          {r.preset && (
            <span className="settings-hint" data-testid="remote-task-request-preset">
              {presetText(r.preset, workspaces, topics, profiles)}
            </span>
          )}
          {r.attached && <AttachedLine attached={r.attached} />}
          <span className="settings-hint">
            {relativeTime(r.createdAt)}发来 · {r.preset ? "远程设置 → 安全 要你先确认（别的账号的设备）。" : ""}同意后在这台电脑上建任务、开会话，并授权给 {r.name}。
          </span>
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
    </div>
  );
}

const profileLabel = (p: ModelProfile) => `${RUNTIME_LABELS[p.runtime]} · ${p.label}`;

/** What a task waiting for a yes brought along (2026-10-29 evening): kept here until it is allowed or refused. */
function AttachedLine({ attached }: { attached: NonNullable<RemoteTaskRequest["attached"]> }) {
  const names = [...attached.images.map((i) => i.name), ...attached.files.map((f) => f.name)];
  if (!names.length) return null;
  const what = [attached.images.length ? `${attached.images.length} 张图片` : "", attached.files.length ? `${attached.files.length} 个文件` : ""].filter(Boolean).join("、");
  return (
    <span className="settings-hint remote-attached" title={names.join("\n")} data-testid="remote-task-request-attached">
      带了 {what}：{names.join("、")}（同意后随第一句话发给会话，拒绝就删掉）
    </span>
  );
}

/** 安全 (2026-10-29): where a task created from another device would go and its model, as that device picked them. */
function presetText(preset: NonNullable<RemoteTaskRequest["preset"]>, workspaces: readonly Workspace[], topics: readonly Topic[], profiles: readonly ModelProfile[]): string {
  const ws = preset.workspaceId ? workspaces.find((w) => w.id === preset.workspaceId) : null;
  const topic = preset.topicId ? topics.find((t) => t.id === preset.topicId) : null;
  const model = profiles.find((p) => p.id === preset.profileId);
  return `那边选的：${ws ? `项目 ${ws.name}` : "公共目录"}${topic ? ` · 专题「${topic.title}」` : ""} · ${model ? profileLabel(model) : "（这个模型已经没有了）"}`;
}

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
  // A task created from another device (安全): where it picked; a request: the common folder and the default model.
  const preset = request.preset;
  const presetPlace = preset?.workspaceId && places.some((w) => w.id === preset.workspaceId) ? preset.workspaceId : null;
  const [workspaceId, setWorkspaceId] = useState(presetPlace ?? common?.id ?? places[0]?.id ?? "");
  const [topicId, setTopicId] = useState(preset?.topicId && topics.some((t) => t.id === preset.topicId && !t.archivedAt) ? preset.topicId : "");
  const [profileId, setProfileId] = useState(
    preset && models.some((m) => m.id === preset.profileId) ? preset.profileId : remote.allowed.defaultProfile && models.some((m) => m.id === remote.allowed.defaultProfile) ? remote.allowed.defaultProfile : (models[0]?.id ?? ""),
  );
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
      {request.attached && <AttachedLine attached={request.attached} />}
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
          还没有选远端允许的模型：先关掉这个对话框，在「远程」→「远程设置」→「远端允许的模型」里勾上可以给远程任务用的模型并保存。
        </span>
      )}
      <ul className="confirm-risks">
        <li>{preset ? `建任务「${request.title}」，授权给 ${request.name}，用选的模型开会话，把上面这句话作为第一句话发出。` : `建任务「${request.title}」（说明就是请求的内容），授权给 ${request.name}，用选的模型开会话，把请求的内容作为第一句话发出。`}</li>
        <li>会话的权限：{permission}（在「远程」→「远程设置」里改）。命令以这台电脑上你的用户身份运行，用的是这台电脑的模型账号。</li>
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
