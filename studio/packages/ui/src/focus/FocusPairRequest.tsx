import { useState } from "react";
import type { RemoteIncomingRequest } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { relativeTime } from "../lib/status.js";

/**
 * 远程 (2026-10-29, the person): a pairing request is something to deal with on Focus, like an approval — 允许 / 拒绝
 * in place, or 「在远程页里看」 to open the remote page (设置 → 远程 until 10-29). It leaves the list once answered (here, there, or on another of this
 * account's computers).
 */
export function FocusPairRequest({ link, request }: { link: HostLink; request: RemoteIncomingRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function answer(allow: boolean) {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/remote/requests/:id/answer", { id: request.id }, { allow });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <div className="focus-entry open" data-testid="focus-pair-request">
      <div className="focus-row static">
        <span className="dot" style={{ background: "var(--attention)" }} />
        <span className="focus-row-text">
          <span className="focus-title">配对请求 · {request.account}（{request.name}）</span>
          <span className="focus-sub">想和这台电脑配对 · {relativeTime(request.createdAt)}</span>
        </span>
      </div>
      <div className="focus-detail">
        <span className="focus-sub focus-wrap">只在这是你自己的另一台电脑时允许：以后它能用这台电脑上的模型账号跑任务。</span>
        {error && <span className="focus-error">{error}</span>}
        <div className="focus-actions">
          <button type="button" className="focus-approve" disabled={busy} onClick={() => void answer(true)} data-testid="focus-pair-allow">
            允许
          </button>
          <button type="button" className="focus-btn" disabled={busy} onClick={() => void answer(false)} data-testid="focus-pair-refuse">
            拒绝
          </button>
          <button type="button" className="focus-btn" onClick={() => void window.amo?.openInWorkbench?.({ settings: "remote" })} data-testid="focus-pair-settings">
            在远程页里看
          </button>
        </div>
      </div>
    </div>
  );
}
