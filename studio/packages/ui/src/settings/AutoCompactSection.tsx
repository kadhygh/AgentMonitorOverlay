import { useEffect, useState } from "react";
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, DEFAULT_AUTO_COMPACT_TOKENS, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 自动压缩点 (2026-10-17): when Claude and Codex sessions summarise their conversation by themselves. Every model call
// reads the whole context, so a long session left to grow toward a 1M window costs more and more per step.

const k = (tokens: number) => String(Math.round(tokens / 1000));

export function AutoCompactSection({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const current = settings?.autoCompactTokens;
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(current ? k(current) : ""), [current]);
  if (!settings) return null;

  async function save(tokens: number | null) {
    setBusy(true);
    setMessage(null);
    try {
      await call(link, "PUT /api/settings", {}, { autoCompactTokens: tokens });
      setMessage({ text: tokens === null ? "已改为由 CLI 自己决定：之后启动的会话生效" : `已设为 ${k(tokens)}k：之后启动或恢复的会话生效` });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const n = Math.round(Number(text) * 1000);
    if (!text.trim() || !Number.isFinite(n) || n < AUTO_COMPACT_MIN || n > AUTO_COMPACT_MAX) {
      setMessage({ text: `填 ${k(AUTO_COMPACT_MIN)} 到 ${k(AUTO_COMPACT_MAX)} 之间的数（单位千 token）`, error: true });
      return;
    }
    void save(n);
  }

  return (
    <section className="settings-section" aria-label="自动压缩点">
      <div className="settings-row">
        <span className="settings-heading">自动压缩点</span>
        <span className="spacer" />
        {current === null ? (
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void save(DEFAULT_AUTO_COMPACT_TOKENS)} data-testid="auto-compact-default">
            用 {k(DEFAULT_AUTO_COMPACT_TOKENS)}k
          </button>
        ) : (
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void save(null)} data-testid="auto-compact-cli">
            交给 CLI 决定
          </button>
        )}
      </div>
      <span className="settings-hint">
        Claude 和 Codex 会话的上下文到这里时自动把对话总结一次。每次模型调用都要把整个上下文读一遍，上下文越大每一步越贵；不设时 CLI 要等到接近模型的整个窗口（Claude 订阅是 100 万）才压缩。
      </span>
      {current === null ? (
        <span className="settings-hint" data-testid="auto-compact-off">现在由 CLI 自己决定。</span>
      ) : (
        <div className="settings-row">
          <input
            className="field"
            inputMode="numeric"
            aria-label="自动压缩点（千 token）"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            data-testid="auto-compact-input"
          />
          <span className="settings-label">k token</span>
          <button type="button" className="btn-primary small" disabled={busy || text === k(current!)} onClick={submit} data-testid="auto-compact-save">
            保存
          </button>
        </div>
      )}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </span>
      )}
    </section>
  );
}
