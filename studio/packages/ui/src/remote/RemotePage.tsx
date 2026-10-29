import { useEffect, useRef, useState } from "react";
import { PEER_PRESENCE_LABEL, peerPresence, REMOTE_PERMISSION_LABEL, REMOTE_PERMISSIONS, RUNTIME_LABELS, type ModelProfile, type PeerPresence, type RemoteAllowed, type RemoteConnection, type RemotePeer, type RemotePermission, type RemotePingResult, type RemoteState, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { relativeTime } from "../lib/status.js";
import { BackButton } from "../shell/BackButton.js";
import { copyStatus, useRemote } from "./remote.js";
import { AskDialog, AskRows, IncomingTaskRequests } from "./RemoteRequests.js";
import { PairDialog } from "./PairDialog.js";

// 远程 (2026-10-29, plans/remote-page-and-new-task.md §1–3): a page of its own, opened from the top bar (设置 → 远程
// before). Top to bottom, in the order it is used: who and where this computer is on the team server (one quiet line,
// or why it is not connected); 任务 — what waits here, the tasks this computer granted, the remote tasks on it and the
// requests it sent; the paired devices (+ 配对设备); 远程设置, folded. Pairing is for the person's own other computers
// only: a remote session runs on this computer's model accounts, and a personal subscription is not for anyone else.

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

export function RemotePage({
  link,
  tasks = [],
  profiles = [],
  workspaces = [],
  topics = [],
  backLabel,
  onBack,
  onOpenTask,
}: {
  link: HostLink;
  tasks?: readonly Task[];
  profiles?: readonly ModelProfile[];
  workspaces?: readonly Workspace[];
  topics?: readonly Topic[];
  backLabel: string;
  onBack(): void;
  /** A granted task or a remote copy opened from here (its 「←」 returns here). */
  onOpenTask(taskId: string): void;
}) {
  const remote = useRemote(link);
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title || "未命名任务";
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pings, setPings] = useState<Record<string, RemotePingResult | "busy">>({});
  const [unpairing, setUnpairing] = useState<RemotePeer | null>(null);
  const [pairing, setPairing] = useState(false);
  /** Step 4: the device being asked to run a task (step 3 of the page plan points this at the new-task page). */
  const [asking, setAsking] = useState<RemotePeer | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLElement>(null);
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

  const openSettings = () => {
    setSettingsOpen(true);
    requestAnimationFrame(() => settingsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const head = (
    <div className="page-head">
      <BackButton label={backLabel} onClick={onBack} />
      <span className="page-crumb">/ 远程</span>
    </div>
  );

  if (!remote)
    return (
      <section className="remote-page" aria-label="远程">
        {head}
        <div className="placeholder">读取中…</div>
      </section>
    );

  const { connection } = remote;
  if (!remote.account || connection.state === "off")
    return (
      <section className="remote-page" aria-label="远程">
        {head}
        <div className="remote-wrap">
          <div className="remote-body">
            <div className="remote-login" data-testid="remote-login">
              <span className="remote-login-title" data-testid="remote-account">
                {connection.state === "off" ? "这个 Studio 没有开远程功能" : "在 AMO 平台里登录"}
              </span>
              {connection.state !== "off" && (
                <span className="settings-hint" data-testid="remote-login-hint">
                  远程功能用的是团队服务器的账号，登录只在 AMO 平台里做（Studio 不另做登录）。登录后这一页会自动连上，不用重启 Studio。Studio 的其他功能不受影响。
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
    );

  const devices = devicesOf(remote.peers);
  const copies = tasks.filter((t) => t.remote && !t.archivedAt);
  const waiting = remote.incoming.length + remote.taskRequests.length;
  const outgoing = remote.outgoing;
  const retryIn = connection.retryAt ? Math.max(0, Math.ceil((Date.parse(connection.retryAt) - Date.now()) / 1000)) : null;

  return (
    <section className="remote-page" aria-label="远程">
      {head}
      <div className="remote-wrap">
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
            <span className="spacer" />
            <button type="button" className="btn-ghost small" aria-expanded={settingsOpen} onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())} data-testid="remote-settings-open">
              远程设置
            </button>
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

          {message && (
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
                        {/* Step 4: a device that allowed this computer can run a task for it (the new-task page's remote mode later). */}
                        {guest && (
                          <button
                            type="button"
                            className="btn-ghost small"
                            disabled={busy || !online}
                            title={online ? `在 ${p.name} 上建一个任务：写清要做什么，${p.name} 同意后在那边开跑，这台电脑的看板上能看到` : `${p.name} 不在线：要它在线时才能发（团队服务器不替你存请求）`}
                            onClick={() => setAsking(p)}
                            data-testid="remote-ask-open"
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

          <section ref={settingsRef} className="remote-section remote-settings" aria-label="远程设置" data-testid="remote-settings">
            <button type="button" className="remote-fold-btn remote-heading" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)} data-testid="remote-settings-toggle">
              <span className="remote-fold-mark" aria-hidden="true">
                {settingsOpen ? "▾" : "▸"}
              </span>
              远程设置
            </button>
            {!settingsOpen && <span className="settings-hint">本机设备名、远端允许的模型、被远程使用时不睡眠。</span>}
            {settingsOpen && (
              <>
                <DeviceName link={link} remote={remote} busy={busy} run={run} />
                <AllowedModels key={JSON.stringify(remote.allowed)} allowed={remote.allowed} profiles={profiles} busy={busy} onSave={(next) => void run(() => call(link, "PUT /api/remote/allowed", {}, next), "已保存远端允许的模型")} />
                <div className="remote-subsection">
                  <span className="remote-subheading">被远程使用时</span>
                  <span className="settings-hint" data-testid="remote-awake-note">
                    有任务授权给在线的设备时，这台电脑不会自动睡眠（屏幕照常会关），免得那边用到一半断掉；设备都断开或授权都收回后恢复。托盘「完全退出」前也会先提醒。
                  </span>
                  <span className="settings-hint">这台电脑主动连出到团队服务器，不对局域网开端口。</span>
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      {pairing && <PairDialog link={link} remote={remote} onClose={() => setPairing(false)} />}
      {asking && (
        <AskDialog
          link={link}
          peer={asking}
          onClose={() => setAsking(null)}
          onDone={(text) => {
            setAsking(null);
            setMessage({ text });
          }}
        />
      )}
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
    </section>
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
