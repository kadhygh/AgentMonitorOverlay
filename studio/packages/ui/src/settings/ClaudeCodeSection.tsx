import { useEffect, useState } from "react";
import type { ClaudeCodeStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 模型 → a channel on Claude Code (2026-10-24): which Claude Code its sessions run on. The portable Studio ships
// none: the person installs Claude Code, and until then Claude 订阅, GLM and every Claude 方案 channel are unavailable.

const SOURCE: Record<NonNullable<ClaudeCodeStatus["source"]>, string> = {
  installed: "本机安装的",
  bundled: "SDK 附带的（源码运行）",
  env: "AMO_STUDIO_CLAUDE 指定的",
};

export function ClaudeCodeSection({ link }: { link: HostLink }) {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    call(link, "GET /api/claude-code")
      .then(setStatus)
      .catch(() => undefined);
  }, [link]);

  async function check() {
    setBusy(true);
    setMessage(null);
    try {
      const s = await call(link, "POST /api/claude-code/check");
      setStatus(s);
      setMessage({ text: s.path ? "已找到 Claude Code，Claude 相关的渠道可以用了" : "还是没有找到", error: !s.path });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <div className="claude-code-section" data-testid="claude-code-section" data-found={status.path ? "1" : "0"}>
      <div className="settings-row">
        <span className="settings-label">Claude Code 客户端</span>
        <span className={`credential-state${status.path ? " saved" : ""}`} data-testid="claude-code-state">
          {status.path ? `${SOURCE[status.source!]}${status.version ? ` · 版本 ${status.version}` : ""}` : "没有找到"}
        </span>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void check()} data-testid="claude-code-check">
          {busy ? "检测中…" : "重新检测"}
        </button>
      </div>
      {status.path && (
        <code className="login-dir" title={status.path}>
          {status.path}
        </code>
      )}
      {!status.path && (
        <span className="form-error" role="alert">
          Claude 订阅、智谱 GLM 和所有「Claude 方案」的第三方渠道都要用 Claude Code 运行，现在都不能用。
        </span>
      )}
      {!status.path && (
        <span className="settings-hint">
          安装：在 PowerShell 里运行 <code>irm https://claude.ai/install.ps1 | iex</code>（或 <code>npm i -g @anthropic-ai/claude-code</code>），装好后点「重新检测」，不用重启 Studio。
        </span>
      )}
      {status.outdated && (
        <span className="form-error">
          版本比 Studio 用的 SDK（Claude Code {status.sdkVersion}）旧，有些功能可能不正常：在终端运行 <code>claude update</code> 后点「重新检测」。
        </span>
      )}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </span>
      )}
    </div>
  );
}
