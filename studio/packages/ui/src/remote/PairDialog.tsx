import { useEffect, useState } from "react";
import type { RemoteOnlineDevice, RemoteOutgoingRequest, RemoteState } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { relativeTime } from "../lib/status.js";
import { Dialog } from "./RemoteRequests.js";

// 配对设备 (2026-10-29, plans/remote-page-and-new-task.md §3): the other devices of this computer's own account that are
// online now (the team server lists them), one picked → 「发起配对」 → 「等 <name> 允许」 with 撤回. Pairing is for the
// person's own computers (a remote session runs on this computer's model accounts); another account's name is folded
// below, for test accounts and the like.

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));
const sameKey = (a: { account: string; device: string }, b: { account: string; device: string }) => a.account === b.account && a.device === b.device;

export function PairDialog({ link, remote, onClose }: { link: HostLink; remote: RemoteState; onClose(): void }) {
  const me = remote.account?.name ?? "";
  const [devices, setDevices] = useState<RemoteOnlineDevice[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [byAccount, setByAccount] = useState(false);
  const [account, setAccount] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await call(link, "GET /api/remote/devices/online");
      setDevices(r.devices);
      setSupported(r.supported);
      if (!r.supported) setByAccount(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps -- once, then 刷新

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const waitingFor = (d: RemoteOnlineDevice): RemoteOutgoingRequest | undefined => remote.outgoing.find((r) => r.to === me && r.toDevice?.device === d.device);
  const paired = (d: RemoteOnlineDevice) => remote.peers.some((p) => sameKey(p, { account: me, device: d.device }));
  const byName = remote.outgoing.filter((r) => !r.toDevice);
  const withdraw = (r: RemoteOutgoingRequest) => void run(() => call(link, "DELETE /api/remote/requests/:id", { id: r.id }));
  const sendByAccount = () => void run(() => call(link, "POST /api/remote/pair", {}, { account }).then(() => setAccount("")), `已发出，等 ${account.trim()} 的电脑允许`);

  return (
    <Dialog
      title="配对一台设备"
      testId="remote-pair-dialog"
      busy={busy}
      onClose={onClose}
      className="remote-pair-modal"
      head={
        <button type="button" className="btn-ghost small" disabled={loading || busy} onClick={() => void load()} data-testid="remote-pair-refresh">
          {loading ? "刷新中…" : "刷新"}
        </button>
      }
    >
      <span className="settings-hint remote-warning" data-testid="remote-own-only">
        只配对你自己的其他设备：远程会话用的是这台电脑上的模型账号，个人订阅不能给别人用。
      </span>
      {supported && <span className="settings-hint">下面是你的账号（{me}）下现在在线的其他设备。选一台发起配对，在那台电脑上点「允许」后，两边就配好了。</span>}
      {devices === null && loading && <span className="settings-hint">正在问团队服务器…</span>}
      {supported && devices && (
        <div className="remote-pair-list" role="list">
          {devices.length === 0 && (
            <span className="settings-hint" data-testid="remote-online-empty">
              你的账号下现在没有别的设备在线。在另一台电脑上打开 Studio（AMO 平台登录同一个账号）后点「刷新」。
            </span>
          )}
          {devices.map((d) => {
            const waiting = waitingFor(d);
            const done = paired(d);
            return (
              <div key={d.device} className="remote-row remote-pair-item" role="listitem" data-testid="remote-online-device" data-name={d.name}>
                <span className="remote-row-main">
                  <span className="remote-card-title">{d.name}</span>
                  <span className="settings-hint">{relativeTime(d.since) === "刚刚" ? "刚刚上线" : `${relativeTime(d.since)}上线`}</span>
                </span>
                {done ? (
                  <span className="settings-hint" data-testid="remote-online-paired">
                    已配对
                  </span>
                ) : waiting ? (
                  <>
                    <span className={waiting.state === "refused" ? "settings-hint remote-ask-refused" : "settings-hint"} data-testid="remote-pair-waiting" data-state={waiting.state}>
                      {waiting.state === "pending" ? `等 ${d.name} 允许` : `${d.name} 拒绝了`}
                    </span>
                    <button type="button" className="btn-ghost small" disabled={busy} onClick={() => withdraw(waiting)} data-testid="remote-pair-withdraw">
                      {waiting.state === "pending" ? "撤回" : "知道了"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-primary small" disabled={busy} onClick={() => void run(() => call(link, "POST /api/remote/pair", {}, { account: me, device: d.device }))} data-testid="remote-pair-device">
                    发起配对
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {supported && devices && devices.some((d) => waitingFor(d)?.state === "pending") && <span className="settings-hint">那台电脑会在 Focus 和它的远程页里看到请求。不在线的话请求保留 7 天。</span>}
      {!supported && (
        <span className="settings-hint" data-testid="remote-online-unsupported">
          团队服务器上的中转服务还不能列出在线的设备（要更新），先用下面的账号名配对。
        </span>
      )}

      <button type="button" className="remote-fold-btn" aria-expanded={byAccount} onClick={() => setByAccount((v) => !v)} data-testid="remote-pair-by-account">
        <span className="remote-fold-mark" aria-hidden="true">
          {byAccount ? "▾" : "▸"}
        </span>
        对方用的是别的账号？输入账号名
      </button>
      {byAccount && (
        <div className="remote-pair-account">
          <div className="settings-row">
            <input className="field" value={account} onChange={(e) => setAccount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && account.trim() && sendByAccount()} placeholder="对方电脑登录的 AMO 账号名" aria-label="对方的账号名" data-testid="remote-pair-account" />
            <button type="button" className="btn-primary small" disabled={busy || !account.trim()} onClick={sendByAccount} data-testid="remote-pair-send">
              发送配对请求
            </button>
          </div>
          <span className="settings-hint">那个账号登录着的电脑都会收到请求（不在线的话保留 7 天），其中一台点「允许」后就配好了。</span>
          {byName.map((r) => (
            <div key={r.id} className="remote-row" data-testid="remote-pair-outgoing" data-state={r.state}>
              <span className="remote-row-main settings-hint">{r.state === "pending" ? `等 ${r.to} 允许（${relativeTime(r.createdAt)}发出）` : `${r.to}${r.answeredBy ? `（${r.answeredBy}）` : ""} 拒绝了配对`}</span>
              <button type="button" className="btn-ghost small" disabled={busy} onClick={() => withdraw(r)}>
                {r.state === "pending" ? "撤回" : "知道了"}
              </button>
            </div>
          ))}
        </div>
      )}
      {note && (
        <span className="settings-hint" role="status" data-testid="remote-pair-note">
          {note}
        </span>
      )}
      {error && (
        <span className="form-error" role="alert" data-testid="remote-pair-error">
          {error}
        </span>
      )}
      <div className="settings-row end">
        <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy} data-testid="remote-pair-close">
          关闭
        </button>
      </div>
    </Dialog>
  );
}
