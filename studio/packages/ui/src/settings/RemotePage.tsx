import { useEffect, useState } from "react";
import { PEER_PRESENCE_LABEL, peerPresence, type RemoteConnection, type RemotePeer, type RemotePingResult, type RemoteState } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { relativeTime } from "../lib/status.js";
import { useRemote } from "./remote.js";

// 设置 → 远程 (2026-10-29, plans/remote-session.md step 1): this computer as a device on the team server, the devices
// paired with it, pairing requests both ways. Pairing is for the person's own other computers only: a remote session
// will run on this computer's model accounts, and a personal subscription is not for anyone else.

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

export function RemotePage({ link }: { link: HostLink }) {
  const remote = useRemote(link);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [pings, setPings] = useState<Record<string, RemotePingResult | "busy">>({});
  const [unpairing, setUnpairing] = useState<RemotePeer | null>(null);
  // 刚失联 turns into 离线 by the clock alone.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

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

  if (!remote) return <span className="settings-hint">读取中…</span>;
  const { connection } = remote;
  const loggedIn = !!remote.account && connection.state !== "off";
  const deviceName = name ?? remote.device?.name ?? "";

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

  return (
    <>
      <section className="settings-section" aria-label="本机" data-testid="remote-self">
        <span className="settings-heading">本机</span>
        <span className="settings-hint">配对以后，你的另一台电脑可以通过团队服务器找到这台电脑（以后用来远程使用这里的任务和会话）。这台电脑主动连出到服务器，不对局域网开端口。</span>
        <div className="settings-row">
          <span className="settings-label">设备名</span>
          <input
            className="field"
            value={deviceName}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && deviceName.trim() && void run(() => call(link, "PUT /api/remote/device", {}, { name: deviceName }).then(() => setName(null)), "设备名已保存")}
            placeholder="例如 书房台式机"
            aria-label="设备名"
            maxLength={40}
            disabled={!remote.device}
            data-testid="remote-device-name"
          />
          <button
            type="button"
            className="btn-primary small"
            disabled={busy || !remote.device || !deviceName.trim() || deviceName.trim() === remote.device.name}
            onClick={() => void run(() => call(link, "PUT /api/remote/device", {}, { name: deviceName }).then(() => setName(null)), "设备名已保存")}
          >
            保存
          </button>
        </div>
        <span className="settings-hint">对方看到的就是这个名字。和 AMO 平台共用（存在 %APPDATA%\AMO\device.json）。</span>
        <div className="settings-row">
          <span className="settings-label">账号</span>
          {remote.account ? (
            <span className="settings-hint" data-testid="remote-account">
              {remote.account.name} · {remote.account.server.replace(/^http:\/\//, "")}
            </span>
          ) : (
            <span className="settings-hint" data-testid="remote-account">
              {connection.state === "off" ? "这个 Studio 没有开远程功能" : "没有登录：在 AMO 平台里登录后才能用远程功能"}
            </span>
          )}
        </div>
        {remote.account && (
          <div className="settings-row" data-testid="remote-connection" data-state={connection.state}>
            <span className="settings-label">服务器</span>
            <span className={`remote-conn remote-conn-${connection.state}`}>{CONNECTION_LABEL[connection.state]}</span>
            {connection.state === "online" && connection.since && <span className="settings-hint">自 {fmtTime(connection.since)}</span>}
            {connection.state !== "online" && connection.state !== "connecting" && (
              <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(() => call(link, "POST /api/remote/reconnect"))} data-testid="remote-reconnect">
                重新连接
              </button>
            )}
          </div>
        )}
        {remote.account && connection.message && connection.state !== "online" && <span className="settings-hint">{connection.message}</span>}
        {!remote.account && connection.state !== "off" && (
          <span className="settings-hint" data-testid="remote-login-hint">
            远程功能用的是团队服务器的账号，登录只在 AMO 平台里做（Studio 不另做登录）。登录后这一页会自动连上，不用重启 Studio。Studio 的其他功能不受影响。
          </span>
        )}
      </section>

      {loggedIn && remote.incoming.length > 0 && (
        <section className="settings-section" aria-label="收到的配对请求" data-testid="remote-incoming">
          <span className="settings-heading">收到的配对请求</span>
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
        </section>
      )}

      {loggedIn && (
        <section className="settings-section" aria-label="已配对的设备" data-testid="remote-peers">
          <span className="settings-heading">已配对的设备</span>
          {remote.peers.length === 0 ? (
            <span className="settings-hint" data-testid="remote-no-peers">
              还没有。在下面「配对一台设备」里填另一台电脑登录的账号名发起，或者在那台电脑上向这台发起。
            </span>
          ) : (
            remote.peers.map((p) => {
              const presence = peerPresence(p);
              const pr = pings[peerKey(p)];
              return (
                <div key={`${peerKey(p)}\n${p.role}`} className="remote-card" data-testid="remote-peer" data-account={p.account}>
                  <div className="settings-row">
                    <span className="remote-card-title">{p.name}</span>
                    <span className="settings-hint">{p.account}</span>
                    <span className={`remote-presence remote-presence-${presence}`} data-testid="remote-presence" title={p.lastSeen && presence !== "online" ? `最后在线：${fmtTime(p.lastSeen)}` : undefined}>
                      <span className="dot" aria-hidden="true" />
                      {PEER_PRESENCE_LABEL[presence]}
                    </span>
                  </div>
                  <span className="settings-hint">
                    {p.role === "owner" ? "这台电脑允许了它" : "它允许了这台电脑"} · {fmtTime(p.pairedAt)} 配对
                  </span>
                  <div className="settings-row">
                    {pr && pr !== "busy" && (
                      <span className={pr.ok ? "remote-ping ok" : "remote-ping error"} role="status" data-testid="remote-ping-result">
                        {pr.message}
                      </span>
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
            })
          )}
        </section>
      )}

      {loggedIn && (
        <section className="settings-section" aria-label="配对一台设备" data-testid="remote-pair">
          <span className="settings-heading">配对一台设备</span>
          <span className="settings-hint remote-warning" data-testid="remote-own-only">
            只配对你自己的其他设备：远程会话用的是这台电脑上的模型账号，个人订阅不能给别人用。
          </span>
          <div className="settings-row">
            <input
              className="field"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && account.trim() && void run(() => call(link, "POST /api/remote/pair", {}, { account }).then(() => setAccount("")), `已发出，等 ${account.trim()} 的电脑允许`)}
              placeholder="对方电脑登录的 AMO 账号名"
              aria-label="对方的账号名"
              data-testid="remote-pair-account"
            />
            <button type="button" className="btn-primary small" disabled={busy || !account.trim()} onClick={() => void run(() => call(link, "POST /api/remote/pair", {}, { account }).then(() => setAccount("")), `已发出，等 ${account.trim()} 的电脑允许`)} data-testid="remote-pair-send">
              发送配对请求
            </button>
          </div>
          <span className="settings-hint">那个账号登录着的电脑会收到请求（不在线的话保留 7 天）；在那边点「允许」后，两边的「已配对的设备」里就有对方了。</span>
          {remote.outgoing.map((r) => (
            <div key={r.id} className="settings-row remote-outgoing" data-testid="remote-outgoing" data-state={r.state}>
              <span className="settings-hint">
                {r.state === "pending" ? `等 ${r.to} 回复（${relativeTime(r.createdAt)}发出，${fmtTime(r.expiresAt)} 前有效）` : `${r.to}${r.answeredBy ? `（${r.answeredBy}）` : ""} 拒绝了配对`}
              </span>
              <span className="spacer" />
              <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(() => call(link, "DELETE /api/remote/requests/:id", { id: r.id }))}>
                {r.state === "pending" ? "撤回" : "知道了"}
              </button>
            </div>
          ))}
        </section>
      )}

      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="remote-message">
          {message.text}
        </span>
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
            <li>
              两边的「已配对的设备」里都不再有对方（{unpairing.account} 的「{unpairing.name}」{unpairing.role === "owner" ? "不能再通过服务器找到这台电脑" : "这台电脑也不能再找到它"}）。
            </li>
            <li>对方现在不在线的话，它下次连上服务器时就会知道。</li>
            <li>以后想再用，要重新发配对请求，再在被找的那台电脑上允许一次。</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

/** For the Focus entry and tests: one line per request. */
export const requestLine = (r: RemoteState["incoming"][number]) => `${r.account}（${r.name}）想和这台电脑配对`;
