import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PEER_PRESENCE_LABEL, peerPresence, type RemoteState, type Task } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 授权给… (远程 step 2, 2026-10-29): A lets one of the person's other devices work in this task — its sessions keep
// running here, on this computer's model accounts. Only devices this computer allowed to pair can be picked.

export function GrantDialog({ link, task, remote, onClose, onDone }: { link: HostLink; task: Task; remote: RemoteState | null; onClose(): void; onDone(text: string): void }) {
  const granted = new Set((remote?.grants ?? []).filter((g) => g.taskId === task.id).map((g) => `${g.account}\n${g.device}`));
  const peers = (remote?.peers ?? []).filter((p) => p.role === "owner" && !granted.has(`${p.account}\n${p.device}`));
  const [pick, setPick] = useState<string>(peers[0] ? `${peers[0].account}\n${peers[0].device}` : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const connected = remote?.connection.state === "online";

  async function grant() {
    const p = peers.find((x) => `${x.account}\n${x.device}` === pick);
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/remote/grants", {}, { taskId: task.id, account: p.account, device: p.device });
      onDone(`已授权给 ${p.name}：那边的看板上会出现这个任务`);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }

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
      <div className="modal confirm-modal grant-modal" role="dialog" aria-modal="true" aria-labelledby="grant-title" data-testid="grant-dialog">
        <span className="modal-title" id="grant-title">
          把「{task.title || "未命名任务"}」授权给…
        </span>
        {!remote || remote.connection.state === "off" || !remote.account ? (
          <span className="settings-hint">远程功能要先在 AMO 平台里登录，再在 设置 → 远程 里和你的另一台电脑配对。</span>
        ) : peers.length === 0 ? (
          <span className="settings-hint" data-testid="grant-none">
            {granted.size ? "已经授权给所有可以授权的设备了。" : "还没有可以授权的设备：在你的另一台电脑上向这台发起配对，这台允许后它就会出现在这里（设置 → 远程）。"}
          </span>
        ) : (
          <div className="grant-peers" role="radiogroup" aria-label="设备">
            {peers.map((p) => {
              const key = `${p.account}\n${p.device}`;
              const presence = peerPresence(p);
              return (
                <label key={key} className="grant-peer" data-testid="grant-peer">
                  <input type="radio" name="grant-peer" checked={pick === key} onChange={() => setPick(key)} />
                  <span className="remote-card-title">{p.name}</span>
                  <span className="settings-hint">{p.account}</span>
                  <span className={`remote-presence remote-presence-${presence}`}>
                    <span className="dot" aria-hidden="true" />
                    {PEER_PRESENCE_LABEL[presence]}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <ul className="confirm-risks">
          <li>那台设备能看到这个任务的标题、说明和它的全部会话（委派的会话、子 agent 也算），能发消息、审批、打断，能在任务里开新会话（只能用 设置 → 远程 里允许的模型）。</li>
          <li>会话还在这台电脑上跑：命令以这台电脑上你的用户身份运行，用的是这台电脑的模型账号。只授权给你自己的其他设备。</li>
          <li>它在线时，这个任务的提醒只在它那边出现；它离开 5 分钟后交回这台电脑。随时可以在任务的 ⋯ 或 设置 → 远程 里收回。</li>
        </ul>
        {!connected && peers.length > 0 && <span className="settings-hint">这台电脑现在没连上团队服务器：授权会先记下，那台设备要等两边都连上后才看得到。</span>}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="settings-row end">
          <button ref={cancel} type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-primary small" onClick={() => void grant()} disabled={busy || !pick || peers.length === 0} data-testid="grant-confirm">
            授权
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
