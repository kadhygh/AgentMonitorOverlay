import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_REMOTE_SECURITY, NO_REMOTE_PROJECTS, PEER_PRESENCE_LABEL, peerPresence, projectWorkspaces, REMOTE_PERMISSION_LABEL, REMOTE_PERMISSIONS, remoteCreateOpen, RUNTIME_LABELS, type ModelProfile, type PeerPresence, type RemoteAllowed, type RemoteAllowedProjects, type RemoteConnection, type RemotePeer, type RemotePermission, type RemotePingResult, type RemoteSecurity, type RemoteStart, type RemoteState, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { relativeTime } from "../lib/status.js";
import { copyStatus, useRemote } from "./remote.js";
import { AskRows, IncomingTaskRequests } from "./RemoteRequests.js";
import { PairDialog } from "./PairDialog.js";

// 远程 (2026-10-29, plans/remote-page-and-new-task.md §1–3): opened from the top bar (设置 → 远程 before). A dialog since
// the evening of 10-29 (the user: 「远程包成一个弹窗」; a page of its own before), and 远程设置 a second dialog on top of
// it. Top to bottom, in the order it is used: who and where this computer is on the team server (one quiet line, or why
// it is not connected); 任务 — what waits here, the tasks this computer granted, the remote tasks on it and the
// requests it sent; the paired devices (+ 配对设备). Pairing is for the person's own other computers only: a remote
// session runs on this computer's model accounts, and a personal subscription is not for anyone else.

const CONNECTION_LABEL: Record<RemoteConnection["state"], string> = {
  off: "没有开远程功能",
  "no-account": "没有登录",
  connecting: "正在连接…",
  online: "已连接",
  offline: "没连上，稍后自动重试",
  unauthorized: "登录已失效",
  "server-old": "服务器不支持",
  replaced: "被另一个程序顶掉了",
};

const peerKey = (p: { account: string; device: string }) => `${p.account}\n${p.device}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const serverText = (server: string) => server.replace(/^https?:\/\//i, "").replace(/\/+$/, "");

/** A paired device, both ways round in one (a pair each way is two entries in RemoteState.peers). */
interface Device {
  key: string;
  peer: RemotePeer;
  owner: boolean;
  guest: boolean;
}

function devicesOf(peers: readonly RemotePeer[]): Device[] {
  const by = new Map<string, Device>();
  for (const p of peers) {
    const k = peerKey(p);
    const d = by.get(k) ?? { key: k, peer: p, owner: false, guest: false };
    if (p.role === "owner") d.owner = true;
    else d.guest = true;
    // The guest entry carries what 在它上面新建任务 needs; either says who and whether it is online.
    if (p.role === "guest") d.peer = p;
    by.set(k, d);
  }
  return [...by.values()];
}

function presenceText(p: RemotePeer, presence: PeerPresence): string {
  if ((presence === "offline" || presence === "lost") && p.lastSeen) return `${PEER_PRESENCE_LABEL[presence]} · ${relativeTime(p.lastSeen)}`;
  return PEER_PRESENCE_LABEL[presence];
}

function Presence({ peer, testId }: { peer: RemotePeer | undefined; testId?: string }) {
  const presence = peer ? peerPresence(peer) : "unknown";
  return (
    <span className={`remote-presence remote-presence-${presence}`} data-testid={testId} title={peer?.lastSeen && presence !== "online" ? `最后在线：${fmtTime(peer.lastSeen)}` : undefined}>
      <span className="dot" aria-hidden="true" />
      {peer ? presenceText(peer, presence) : PEER_PRESENCE_LABEL.unknown}
    </span>
  );
}

/**
 * A dialog of 远程's (the dialog itself and 远程设置 on top of it): Escape and a click beside it close it, but not an
 * Escape meant for a dialog opened from it (配对, 解除配对, 同意…: portals of their own, outside this one's box).
 */
function RemoteModal({ label, testId, className, onClose, head, children }: { label: string; testId: string; className: string; onClose(): void; head: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // Focus comes in when it opens (so Escape closes this one, not the one under it) and goes back when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop remote-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || !box.current?.contains(e.target as Node)) return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div ref={box} className={`modal remote-modal ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-testid={testId}>
        <div className="modal-head remote-modal-head">
          <span className="modal-title">{label}</span>
          <span className="spacer" />
          {head}
          <button type="button" className="link-btn" onClick={onClose} aria-label={`关闭${label}`} data-testid={`${testId}-close`}>
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function RemoteDialog({
  link,
  tasks = [],
  profiles = [],
  workspaces = [],
  topics = [],
  onClose,
  onOpenTask,
  onNewTaskOn,
}: {
  link: HostLink;
  tasks?: readonly Task[];
  profiles?: readonly ModelProfile[];
  workspaces?: readonly Workspace[];
  topics?: readonly Topic[];
  onClose(): void;
  /** A granted task or a remote copy opened from here (the dialog closes). */
  onOpenTask(taskId: string): void;
  /** 「在它上面新建任务」: the new-task page in 「在别的设备上」 with that device picked (远程创建, 2026-10-29). */
  onNewTaskOn(peer: { account: string; device: string }): void;
}) {
  const remote = useRemote(link);
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title || "未命名任务";
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pings, setPings] = useState<Record<string, RemotePingResult | "busy">>({});
  const [unpairing, setUnpairing] = useState<RemotePeer | null>(null);
  const [pairing, setPairing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 刚失联 turns into 离线 by the clock alone; the next retry counts down while offline.
  const offline = !!remote && ["offline", "unauthorized", "server-old", "replaced"].includes(remote.connection.state);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), offline ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [offline]);

  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage({ text: done });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function ping(p: RemotePeer) {
    const k = peerKey(p);
    setPings((m) => ({ ...m, [k]: "busy" }));
    try {
      const r = await call(link, "POST /api/remote/ping", {}, { account: p.account, device: p.device });
      setPings((m) => ({ ...m, [k]: r }));
    } catch (err) {
      setPings((m) => ({ ...m, [k]: { ok: false, ms: null, message: err instanceof HostApiError ? err.message : String(err) } }));
    }
  }

  const shell = (children: ReactNode, head?: ReactNode) => (
    <RemoteModal label="远程" testId="remote-dialog" className="remote-main-modal" onClose={onClose} head={head}>
      {children}
    </RemoteModal>
  );

  if (!remote) return shell(<div className="placeholder">读取中…</div>);

  const { connection } = remote;
  if (!remote.account || connection.state === "off")
    return shell(
      <div className="remote-body">
        <div className="remote-login" data-testid="remote-login">
          <span className="remote-login-title" data-testid="remote-account">
            {connection.state === "off" ? "这个 Studio 没有开远程功能" : "在 AMO 平台里登录"}
          </span>
          {connection.state !== "off" && (
            <span className="settings-hint" data-testid="remote-login-hint">
              远程功能用的是团队服务器的账号，登录只在 AMO 平台里做（Studio 不另做登录）。登录后这里会自动连上，不用重启 Studio。Studio 的其他功能不受影响。
            </span>
          )}
        </div>
      </div>,
    );

  const devices = devicesOf(remote.peers);
  const copies = tasks.filter((t) => t.remote && !t.archivedAt);
  const waiting = remote.incoming.length + remote.taskRequests.length;
  const outgoing = remote.outgoing;
  const retryIn = connection.retryAt ? Math.max(0, Math.ceil((Date.parse(connection.retryAt) - Date.now()) / 1000)) : null;

  return (
    <>
      {shell(
        <div className="remote-body">
          <div className="remote-self" data-testid="remote-self">
            <span className="remote-self-line">
              <span data-testid="remote-account">{remote.account.name}</span>
              <span className="remote-sep">·</span>
              <span>团队服务器 {serverText(remote.account.server)}</span>
              <span className="remote-sep">·</span>
              <span className={`remote-conn remote-conn-${connection.state}`} data-testid="remote-connection" data-state={connection.state} title={connection.state === "online" && connection.since ? `自 ${fmtTime(connection.since)}` : undefined}>
                {connection.state === "online" ? "✓ " : connection.state === "connecting" ? "◐ " : "! "}
                {CONNECTION_LABEL[connection.state]}
              </span>
              <span className="remote-sep">·</span>
              <span>
                本机「<span data-testid="remote-device-label">{remote.device?.name ?? "（还没有设备名）"}</span>」
              </span>
            </span>
          </div>

          {offline && (
            <div className="remote-offline" role="alert" data-testid="remote-offline">
              <span className="remote-offline-text">
                <strong>! {CONNECTION_LABEL[connection.state]}</strong>
                {connection.message && <span>{connection.message}</span>}
                {connection.state === "offline" && <span>{retryIn !== null && retryIn > 0 ? `${retryIn} 秒后自动重试` : "正在重试…"}；这段时间别的设备找不到这台电脑，远程任务也发不了消息。</span>}
              </span>
              <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(() => call(link, "POST /api/remote/reconnect"))} data-testid="remote-reconnect">
                立即重试
              </button>
            </div>
          )}

          {/* While 远程设置 is open, what it says shows there. */}
          {message && !settingsOpen && (
            <span className={message.error ? "form-error" : "settings-hint remote-message"} role={message.error ? "alert" : "status"} data-testid="remote-message">
              {message.text}
            </span>
          )}

          <section className="remote-section" aria-label="任务" data-testid="remote-tasks">
            <h2 className="remote-heading">任务</h2>

            {waiting > 0 && (
              <div className="remote-group" aria-label="等你处理" data-testid="remote-waiting">
                <span className="remote-group-title">等你处理</span>
                {remote.incoming.length > 0 && (
                  <div className="remote-cards" aria-label="收到的配对请求" data-testid="remote-incoming">
                    {remote.incoming.map((r) => (
                      <div key={r.id} className="remote-card attention" data-testid="remote-request">
                        <span className="remote-card-title">
                          {r.account}（{r.name}）想和这台电脑配对
                        </span>
                        <span className="settings-hint">
                          {relativeTime(r.createdAt)}发来 · 不处理的话 {fmtTime(r.expiresAt)} 作废。只在这是你自己的另一台电脑时允许：以后它能用这台电脑上的模型账号跑任务。
                        </span>
                        <div className="settings-row end">
                          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(() => call(link, "POST /api/remote/requests/:id/answer", { id: r.id }, { allow: false }), `已拒绝 ${r.account}（${r.name}）`)} data-testid="remote-refuse">
                            拒绝
                          </button>
                          <button type="button" className="btn-primary small" disabled={busy} onClick={() => void run(() => call(link, "POST /api/remote/requests/:id/answer", { id: r.id }, { allow: true }), `已和 ${r.account}（${r.name}）配对`)} data-testid="remote-allow">
                            允许
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <IncomingTaskRequests link={link} remote={remote} workspaces={workspaces} topics={topics} profiles={profiles} busy={busy} run={run} />
              </div>
            )}

            <div className="remote-group" aria-label="授权给别的设备的" data-testid="remote-grants">
              <span className="remote-group-title">授权给别的设备的</span>
              {remote.grants.length === 0 ? (
                <span className="settings-hint" data-testid="remote-no-grants">
                  还没有。在任务页右上角的 ⋯ 里点「授权给…」，你的另一台电脑就能远程使用那个任务（会话还在这台电脑上跑）。
                </span>
              ) : (
                remote.grants.map((g) => {
                  const peer = remote.peers.find((p) => p.account === g.account && p.device === g.device && p.role === "owner");
                  return (
                    <div key={`${g.taskId}\n${g.account}\n${g.device}`} className="remote-row" data-testid="remote-grant">
                      <span className="remote-row-main">
                        <span className="remote-card-title">{taskTitle(g.taskId)}</span>
                        <span className="settings-hint">
                          给 {g.name}（{g.account}）· {relativeTime(g.grantedAt)}授权
                        </span>
                        <Presence peer={peer} />
                      </span>
                      <button type="button" className="btn-ghost small" onClick={() => onOpenTask(g.taskId)} disabled={!tasks.some((t) => t.id === g.taskId)} data-testid="remote-grant-open">
                        打开
                      </button>
                      <button type="button" className="btn-ghost small danger" disabled={busy} title="那边保留已经同步的记录（只读），不能再操作这个任务" onClick={() => void run(() => call(link, "POST /api/remote/grants/revoke", {}, { taskId: g.taskId, account: g.account, device: g.device }), `已收回 ${g.name} 对「${taskTitle(g.taskId)}」的授权`)} data-testid="remote-revoke">
                        收回
                      </button>
                    </div>
                  );
                })
              )}
              {remote.grants.length > 0 && <span className="settings-hint">被授权的设备在线时，这些任务的提醒（审批、提问、回复完了）只在它那边出现；它断开 5 分钟后交回这台电脑。</span>}
            </div>

            <div className="remote-group" aria-label="在别的设备上跑的" data-testid="remote-copies">
              <span className="remote-group-title">在别的设备上跑的</span>
              {copies.length === 0 && remote.asks.length === 0 && (
                <span className="settings-hint" data-testid="remote-no-copies">
                  还没有。别的设备把任务授权给这台电脑后，它出现在这里和看板上；会话在那台电脑上跑。
                </span>
              )}
              {copies.map((t) => {
                const st = copyStatus(t, remote);
                return (
                  <div key={t.id} className="remote-row" data-testid="remote-copy" data-state={st?.state}>
                    <span className="remote-row-main">
                      <span className="remote-card-title">{t.title || "未命名任务"}</span>
                      <span className="settings-hint">在 {t.remote!.name}</span>
                      <span className={`remote-presence remote-presence-${st?.state === "online" ? "online" : st?.state === "revoked" ? "offline" : "lost"}`}>
                        <span className="dot" aria-hidden="true" />
                        {st?.state === "online" ? "在线" : (st?.label ?? "")}
                      </span>
                    </span>
                    <button type="button" className="btn-ghost small" onClick={() => onOpenTask(t.id)} data-testid="remote-copy-open">
                      打开
                    </button>
                  </div>
                );
              })}
              <AskRows asks={remote.asks} peers={remote.peers} busy={busy} onWithdraw={(r) => void run(() => call(link, "DELETE /api/remote/asks/:id", { id: r.id }), r.state === "pending" ? `已撤回「${r.title}」` : undefined)} />
            </div>
          </section>

          <section className="remote-section" aria-label="已配对的设备" data-testid="remote-peers">
            <div className="remote-section-head">
              <h2 className="remote-heading">已配对的设备</h2>
              {devices.length > 0 && <span className="settings-hint">{devices.length} 台</span>}
              <span className="spacer" />
              <button type="button" className="btn-ghost small" onClick={() => setPairing(true)} data-testid="remote-pair-open">
                + 配对设备
              </button>
            </div>
            {devices.length === 0 ? (
              <span className="settings-hint" data-testid="remote-no-peers">
                还没有。点右上角「+ 配对设备」，从你账号下在线的其他电脑里选一台；或者在那台电脑上向这台发起。
              </span>
            ) : (
              <div className="remote-peer-grid">
                {devices.map(({ key, peer: p, owner, guest }) => {
                  const pr = pings[key];
                  const online = peerPresence(p) === "online";
                  return (
                    <div key={key} className="remote-card" data-testid="remote-peer" data-account={p.account} data-role={owner && guest ? "both" : owner ? "owner" : "guest"}>
                      <div className="settings-row">
                        <span className="remote-card-title">{p.name}</span>
                        <span className="settings-hint">{p.account}</span>
                        <span className="spacer" />
                        <Presence peer={p} testId="remote-presence" />
                      </div>
                      <span className="settings-hint">
                        {owner && guest ? "互相允许" : owner ? "这台电脑允许了它" : "它允许了这台电脑"} · {fmtTime(p.pairedAt)} 配对
                      </span>
                      {pr && pr !== "busy" && (
                        <span className={pr.ok ? "remote-ping ok" : "remote-ping error"} role="status" data-testid="remote-ping-result">
                          {pr.message}
                        </span>
                      )}
                      <div className="settings-row remote-card-actions">
                        {/* A device that allowed this computer: a task on it from the new-task page's 「在别的设备上」 (2026-10-29). */}
                        {guest && (
                          <button
                            type="button"
                            className="btn-ghost small"
                            disabled={!online}
                            title={online ? `打开新任务页，在 ${p.name} 上建任务：建好就在那边开跑，这台电脑的看板上能看到` : `${p.name} 不在线：要它开着 Studio、连上团队服务器才能在它上面建任务`}
                            onClick={() => onNewTaskOn({ account: p.account, device: p.device })}
                            data-testid="remote-new-task"
                          >
                            在它上面新建任务
                          </button>
                        )}
                        <span className="spacer" />
                        <button type="button" className="btn-ghost small" disabled={pr === "busy" || connection.state !== "online"} title={connection.state !== "online" ? "这台电脑没有连上服务器" : "经服务器发一个来回，看能不能找到对方"} onClick={() => void ping(p)} data-testid="remote-ping">
                          {pr === "busy" ? "测试中…" : "测试连接"}
                        </button>
                        <button type="button" className="btn-ghost small danger" disabled={busy} onClick={() => setUnpairing(p)} data-testid="remote-unpair">
                          解除配对
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {outgoing.map((r) => {
              const to = r.toDevice ? r.toDevice.name : r.to;
              return (
                <div key={r.id} className="remote-row" data-testid="remote-outgoing" data-state={r.state}>
                  <span className={r.state === "refused" ? "remote-row-main remote-ask-refused" : "remote-row-main settings-hint"}>
                    {r.state === "pending" ? `等 ${to} 允许配对（${relativeTime(r.createdAt)}发出，${fmtTime(r.expiresAt)} 前有效）` : `${to}${r.answeredBy && !r.toDevice ? `（${r.answeredBy}）` : ""} 拒绝了配对`}
                  </span>
                  <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(() => call(link, "DELETE /api/remote/requests/:id", { id: r.id }))} data-testid="remote-outgoing-withdraw">
                    {r.state === "pending" ? "撤回" : "知道了"}
                  </button>
                </div>
              );
            })}
          </section>
        </div>,
        <button type="button" className="btn-ghost small" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)} data-testid="remote-settings-open">
          远程设置
        </button>,
      )}

      {settingsOpen && (
        <RemoteModal label="远程设置" testId="remote-settings" className="remote-settings-modal" onClose={() => setSettingsOpen(false)} head={null}>
          <div className="remote-body">
            {message && (
              <span className={message.error ? "form-error" : "settings-hint remote-message"} role={message.error ? "alert" : "status"} data-testid="remote-settings-message">
                {message.text}
              </span>
            )}
            <DeviceName link={link} remote={remote} busy={busy} run={run} />
            <Security key={JSON.stringify(remote.security)} security={remote.security ?? DEFAULT_REMOTE_SECURITY} account={remote.account.name} busy={busy} onSave={(next) => void run(() => call(link, "PUT /api/remote/security", {}, next), "已保存安全设置")} />
            <AllowedModels key={JSON.stringify(remote.allowed)} allowed={remote.allowed} profiles={profiles} busy={busy} onSave={(next) => void run(() => call(link, "PUT /api/remote/allowed", {}, next), "已保存远端允许的模型")} />
            <AllowedProjects
              key={JSON.stringify(remote.allowedProjects)}
              allowed={remote.allowedProjects ?? NO_REMOTE_PROJECTS}
              workspaces={workspaces}
              busy={busy}
              onSave={(next) => void run(() => call(link, "PUT /api/remote/allowed-projects", {}, next), "已保存远端允许的项目")}
            />
            <div className="remote-subsection">
              <span className="remote-subheading">被远程使用时</span>
              <span className="settings-hint" data-testid="remote-awake-note">
                有任务授权给在线的设备时，这台电脑不会自动睡眠（屏幕照常会关），免得那边用到一半断掉；设备都断开或授权都收回后恢复。托盘「完全退出」前也会先提醒。
              </span>
              <span className="settings-hint">这台电脑主动连出到团队服务器，不对局域网开端口。</span>
            </div>
          </div>
        </RemoteModal>
      )}

      {pairing && <PairDialog link={link} remote={remote} onClose={() => setPairing(false)} />}
      {unpairing && (
        <ConfirmDialog
          title={`解除和「${unpairing.name}」的配对？`}
          action="解除配对"
          danger
          busy={busy}
          testId="remote-unpair-confirm"
          onCancel={() => setUnpairing(null)}
          onConfirm={() => {
            const p = unpairing;
            void run(() => call(link, "POST /api/remote/unpair", {}, { account: p.account, device: p.device }), `已解除和 ${p.name} 的配对`).then(() => setUnpairing(null));
          }}
        >
          <ul className="confirm-risks">
            <li>两边的「已配对的设备」里都不再有对方（{unpairing.account} 的「{unpairing.name}」和这台电脑互相都找不到了）。</li>
            {(() => {
              const gone = remote.grants.filter((g) => g.account === unpairing.account && g.device === unpairing.device);
              return gone.length > 0 ? (
                <li data-testid="remote-unpair-grants">
                  同时收回授权给它的 {gone.length} 个任务：{gone.map((g) => `「${taskTitle(g.taskId)}」`).join("、")}。那边保留已经同步的记录（只读），任务在这台电脑上照常。
                </li>
              ) : null;
            })()}
            {remote.peers.some((p) => p.role === "guest" && p.account === unpairing.account && p.device === unpairing.device) && <li>它授权给这台电脑的远程任务会变成「授权已收回」，记录还能看。</li>}
            <li>对方现在不在线的话，它下次连上服务器时就会知道。</li>
            <li>以后想再用，要重新发配对请求，再在被找的那台电脑上允许一次。</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

/** 本机设备名: shown as text; 「改名」 turns it into an input. Shared with the AMO platform (device.json). */
function DeviceName({ link, remote, busy, run }: { link: HostLink; remote: RemoteState; busy: boolean; run(fn: () => Promise<unknown>, done?: string): Promise<void> }) {
  const [name, setName] = useState<string | null>(null);
  const current = remote.device?.name ?? "";
  const save = () => name !== null && name.trim() && void run(() => call(link, "PUT /api/remote/device", {}, { name }).then(() => setName(null)), "设备名已保存");
  return (
    <div className="remote-subsection">
      <span className="remote-subheading">本机设备名</span>
      {name === null ? (
        <div className="settings-row">
          <span className="remote-device-name" data-testid="remote-device-current">
            {current || "（还没有）"}
          </span>
          <button type="button" className="btn-ghost small" disabled={!remote.device} onClick={() => setName(current)} data-testid="remote-device-rename">
            改名
          </button>
        </div>
      ) : (
        <div className="settings-row">
          <input
            className="field"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              else if (e.key === "Escape") {
                e.stopPropagation();
                setName(null);
              }
            }}
            placeholder="例如 书房台式机"
            aria-label="设备名"
            maxLength={40}
            data-testid="remote-device-name"
          />
          <button type="button" className="btn-ghost small" onClick={() => setName(null)} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-primary small" disabled={busy || !name.trim() || name.trim() === current} onClick={save} data-testid="remote-device-save">
            保存
          </button>
        </div>
      )}
      <span className="settings-hint">对方看到的就是这个名字。和 AMO 平台共用（存在 %APPDATA%\AMO\device.json）。</span>
    </div>
  );
}

const START_LABEL: Record<RemoteStart, string> = { run: "直接开跑", confirm: "先等我确认" };

/**
 * 安全 (2026-10-29, the user): a paired device of this computer's own account is the person's other computer — what it
 * creates here starts at once by default; a device of another account waits for a yes here by default. Requests always
 * wait, and what this computer grants is its own choice, so neither is set here.
 */
function Security({ security, account, busy, onSave }: { security: RemoteSecurity; account: string; busy: boolean; onSave(next: RemoteSecurity): void }) {
  const [next, setNext] = useState<RemoteSecurity>(security);
  const changed = next.sameAccount !== security.sameAccount || next.otherAccount !== security.otherAccount;
  const row = (key: keyof RemoteSecurity, label: string, hint: string) => (
    <div className="settings-row remote-security-row">
      <span className="remote-security-who">
        <span>{label}</span>
        <span className="settings-hint">{hint}</span>
      </span>
      <select value={next[key]} onChange={(e) => setNext((n) => ({ ...n, [key]: e.target.value as RemoteStart }))} aria-label={label} data-testid={`remote-security-${key}`}>
        {(["run", "confirm"] as const).map((v) => (
          <option key={v} value={v}>
            {START_LABEL[v]}
            {v === DEFAULT_REMOTE_SECURITY[key] ? "（默认）" : ""}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <div className="remote-subsection" aria-label="安全" data-testid="remote-security">
      <span className="remote-subheading">安全：别的设备在这台电脑上建的任务</span>
      <span className="settings-hint">配对的设备在它的新任务页选「在别的设备上」建任务时，是在这台电脑上直接开跑，还是先等你确认。</span>
      {row("sameAccount", "同账号的设备", `也用 ${account} 登录的，你自己的其他电脑`)}
      {row("otherAccount", "别的账号的设备", "用其他账号登录的")}
      <span className="settings-hint">「先等我确认」：任务先不建、不跑，这台电脑的 Focus 和「远程」里出现一条请求，看过项目、模型和第一句话后点「同意并开始」才开跑。那边发来的请求总要你同意；你授权出去的任务不受这里影响。</span>
      {next.otherAccount === "run" && (
        <span className="remote-warning" role="note" data-testid="remote-security-warning">
          ! 别的账号的设备建的任务会直接用这台电脑的模型账号跑，命令以你的用户身份运行。Claude、ChatGPT 的个人订阅不能给别人用。
        </span>
      )}
      <div className="settings-row end">
        <button type="button" className="btn-primary small" disabled={busy || !changed} onClick={() => onSave(next)} data-testid="remote-security-save">
          保存
        </button>
      </div>
    </div>
  );
}

/**
 * 远端允许的默认配置 (远程 step 2): which of this computer's models sessions started from a paired device may use, the one
 * offered first, and the permissions they get. Nothing ticked: only the models a task's own sessions already use.
 */
function AllowedModels({ allowed, profiles, busy, onSave }: { allowed: RemoteAllowed; profiles: readonly ModelProfile[]; busy: boolean; onSave(next: RemoteAllowed): void }) {
  const [picked, setPicked] = useState<string[]>(allowed.profiles);
  const [first, setFirst] = useState<string>(allowed.defaultProfile ?? "");
  const [permission, setPermission] = useState<RemotePermission | "">(allowed.permission ?? "");
  const own = profiles.filter((p) => p.runtime !== "remote" && (!p.hidden || allowed.profiles.includes(p.id)) && (!p.unavailable || allowed.profiles.includes(p.id)));
  const changed = JSON.stringify([picked, first, permission]) !== JSON.stringify([allowed.profiles, allowed.defaultProfile ?? "", allowed.permission ?? ""]);
  const firstOk = !first || !picked.length || picked.includes(first);
  return (
    <div className="remote-subsection" aria-label="远端允许的模型" data-testid="remote-allowed">
      <span className="remote-subheading">远端允许的模型</span>
      <span className="settings-hint">被授权的设备在任务里新开会话时能选的模型（会话里 agent 委派的会话也照这个来）。一个都不勾时，只能用这个任务现在的会话已经在用的模型。</span>
      <div className="remote-allowed-list">
        {own.map((p) => (
          <label key={p.id} className="remote-allowed-item" data-testid="remote-allowed-item">
            <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />
            {RUNTIME_LABELS[p.runtime]} · {p.label}
          </label>
        ))}
      </div>
      <div className="settings-row">
        <span className="settings-label">默认</span>
        <select value={first} onChange={(e) => setFirst(e.target.value)} aria-label="默认的模型" data-testid="remote-allowed-default">
          <option value="">（第一个允许的）</option>
          {(picked.length ? own.filter((p) => picked.includes(p.id)) : own).map((p) => (
            <option key={p.id} value={p.id}>
              {RUNTIME_LABELS[p.runtime]} · {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <span className="settings-label">权限</span>
        <select value={permission} onChange={(e) => setPermission(e.target.value as RemotePermission | "")} aria-label="远程会话的权限" data-testid="remote-allowed-permission">
          <option value="">模型自己的默认</option>
          {REMOTE_PERMISSIONS.map((l) => (
            <option key={l} value={l}>
              {REMOTE_PERMISSION_LABEL[l]}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button type="button" className="btn-primary small" disabled={busy || !changed || !firstOk} onClick={() => onSave({ profiles: picked, defaultProfile: first || null, permission: permission || null })} data-testid="remote-allowed-save">
          保存
        </button>
      </div>
      {!firstOk && <span className="form-error">默认的模型要在勾选的里面</span>}
      <span className="settings-hint">远程会话的命令以这台电脑上你的用户身份运行，用的是这台电脑的模型账号。</span>
    </div>
  );
}

/**
 * 远端允许的项目 (2026-10-29, the user: no yes on this computer for a task a paired device creates — this limits it):
 * the projects a paired device may create tasks in from its new-task page (「在别的设备上」), and whether it may leave
 * the project out (the common folder). Nothing ticked: it cannot create tasks here at all.
 */
function AllowedProjects({ allowed, workspaces, busy, onSave }: { allowed: RemoteAllowedProjects; workspaces: readonly Workspace[]; busy: boolean; onSave(next: RemoteAllowedProjects): void }) {
  const [picked, setPicked] = useState<string[]>(allowed.workspaceIds);
  const [common, setCommon] = useState(allowed.common);
  const projects = projectWorkspaces(workspaces);
  // A project ticked and then archived stays listed (greyed) until it is unticked.
  const gone = allowed.workspaceIds.filter((id) => !projects.some((w) => w.id === id)).map((id) => workspaces.find((w) => w.id === id)).filter((w): w is Workspace => !!w);
  const changed = JSON.stringify([[...picked].sort(), common]) !== JSON.stringify([[...allowed.workspaceIds].sort(), allowed.common]);
  const open = remoteCreateOpen({ workspaceIds: picked, common });
  const toggle = (id: string, on: boolean) => setPicked((l) => (on ? [...l, id] : l.filter((x) => x !== id)));
  return (
    <div className="remote-subsection" aria-label="远端允许的项目" data-testid="remote-allowed-projects">
      <span className="remote-subheading">远端允许的项目</span>
      <span className="settings-hint">配对的设备在它的新任务页选「在别的设备上」时，能把任务建在这台电脑的哪些项目里（直接开跑还是先等你确认，见上面的「安全」；模型照上面的「远端允许的模型」）。</span>
      <div className="remote-allowed-list">
        <label className="remote-allowed-item" data-testid="remote-allowed-common">
          <input type="checkbox" checked={common} onChange={(e) => setCommon(e.target.checked)} />
          不选项目（公共文件夹）
        </label>
        {[...projects, ...gone].map((w) => (
          <label key={w.id} className="remote-allowed-item" title={w.path} data-testid="remote-allowed-project">
            <input type="checkbox" checked={picked.includes(w.id)} onChange={(e) => toggle(w.id, e.target.checked)} />
            {w.name}
            {w.archivedAt && <span className="settings-hint">（已归档）</span>}
          </label>
        ))}
      </div>
      {projects.length === 0 && <span className="settings-hint">这台电脑还没有添加项目，只能勾公共文件夹。</span>}
      <div className="settings-row">
        <span className={open ? "settings-hint" : "settings-hint remote-allowed-closed"} data-testid="remote-allowed-projects-state">
          {open ? `别的设备可以在${common ? (picked.length ? `公共文件夹和 ${picked.length} 个项目` : "公共文件夹") : ` ${picked.length} 个项目`}里建任务。` : "! 一个都不勾：别的设备不能在这台电脑上建任务。"}
        </span>
        <span className="spacer" />
        <button type="button" className="btn-primary small" disabled={busy || !changed} onClick={() => onSave({ workspaceIds: picked, common })} data-testid="remote-allowed-projects-save">
          保存
        </button>
      </div>
    </div>
  );
}
