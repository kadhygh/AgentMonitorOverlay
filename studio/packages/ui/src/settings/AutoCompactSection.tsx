import { useEffect, useState } from "react";
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, DEFAULT_AUTO_COMPACT_TOKENS, autoCompactFor, type AutoCompactChoice, type ModelProfile, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 自动压缩点 (2026-10-17): when a session summarises its conversation by itself. Every model call reads the whole
// context, so a long session left to grow toward a 1M window costs more and more per step. S18 (2026-10-18): on each
// channel's page, for that channel; a channel never set follows the shared value (272k unless changed before S18).
// DSH compacts by itself at 80% of the window and has no setting for it.

const k = (tokens: number) => String(Math.round(tokens / 1000));

export function AutoCompactSection({ link, settings, profile }: { link: HostLink; settings: StudioSettings | null; profile: ModelProfile }) {
  const own = settings?.autoCompactProfiles?.[profile.id];
  const current = settings ? autoCompactFor(settings, profile.id) : null;
  const shared = settings?.autoCompactTokens ?? null;
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(current ? k(current) : ""), [current]);
  if (!settings) return null;

  if (profile.runtime === "dsh")
    return (
      <section className="settings-section" aria-label="自动压缩点">
        <span className="settings-heading">自动压缩点</span>
        <span className="settings-hint" data-testid="auto-compact-dsh">
          DSH 自己管理：上下文到模型窗口的 80% 时自动压缩，Studio 不能改。
        </span>
      </section>
    );

  async function save(value: AutoCompactChoice | null) {
    setBusy(true);
    setMessage(null);
    try {
      await call(link, "PUT /api/settings", {}, { autoCompactProfiles: { [profile.id]: value } });
      const then = "之后启动或恢复的会话生效";
      setMessage({ text: value === null ? `已恢复默认（${shared === null ? "交给 CLI 决定" : `${k(shared)}k`}）：${then}` : value === "cli" ? `已改为由 CLI 自己决定：${then}` : `已设为 ${k(value)}k：${then}` });
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
        {own === undefined && <span className="settings-tag" data-testid="auto-compact-shared-tag">默认</span>}
        <span className="spacer" />
        {own !== undefined && (
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void save(null)} title="不再单独设置，跟其他渠道一样用默认值" data-testid="auto-compact-shared">
            恢复默认（{shared === null ? "CLI 决定" : `${k(shared)}k`}）
          </button>
        )}
        {current === null ? (
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void save(DEFAULT_AUTO_COMPACT_TOKENS)} data-testid="auto-compact-default">
            用 {k(DEFAULT_AUTO_COMPACT_TOKENS)}k
          </button>
        ) : (
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void save("cli")} data-testid="auto-compact-cli">
            交给 CLI 决定
          </button>
        )}
      </div>
      <span className="settings-hint">
        这个渠道的会话上下文到这里时自动把对话总结一次。每次模型调用都要把整个上下文读一遍，上下文越大每一步越贵；交给 CLI 时要等到接近模型的整个窗口（Claude 订阅是 100 万）才压缩。
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
          <button type="button" className="btn-primary small" disabled={busy || text === k(current)} onClick={submit} data-testid="auto-compact-save">
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
