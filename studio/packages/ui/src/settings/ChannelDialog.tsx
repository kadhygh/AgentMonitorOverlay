import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AMO_CHANNEL_KEYS, BALANCE_TEMPLATES, CHANNEL_KIND_LABEL, type BalanceConfig, type BalanceTemplate, type ChannelBalance, type ChannelInput, type ChannelKind, type ModelChannel } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { balanceText } from "../lib/balance.js";

// 设置 → 模型 → 添加渠道 / 编辑: a third-party Claude (Anthropic-compatible, run by Claude Code) or Codex (Responses API,
// run by Codex) endpoint — its name, address, key and model — and how to ask its site for the balance (CC Switch's
// templates), with a 测试 that asks once without saving.

const PLACEHOLDER: Record<ChannelKind, string> = {
  claude: "https://example.com/api/anthropic（Claude Code 的 ANTHROPIC_BASE_URL）",
  codex: "https://example.com/v1（Codex 会在后面接 /responses）",
  dsh: "https://example.com/anthropic（Anthropic 兼容的地址，像 https://api.deepseek.com/anthropic）",
};

type Draft = {
  kind: ChannelKind;
  label: string;
  baseUrl: string;
  model: string;
  smallModel: string;
  claudeAuth: "bearer" | "x-api-key";
  key: string;
  keyFrom: string | null;
  template: BalanceTemplate | "none";
  balanceUrl: string;
  userId: string;
  accessToken: string;
  remainingPath: string;
  usedPath: string;
  totalPath: string;
  divisor: string;
  unit: string;
};

function draftOf(c: ModelChannel | null, kind: ChannelKind): Draft {
  const b = c?.balance;
  return {
    kind: c?.kind ?? kind,
    label: c?.label ?? "",
    baseUrl: c?.baseUrl ?? "",
    model: c?.model ?? "",
    smallModel: c?.smallModel ?? "",
    claudeAuth: c?.claudeAuth ?? "bearer",
    key: "",
    keyFrom: c?.keyFrom ?? null,
    template: b?.template ?? "none",
    balanceUrl: b?.url ?? "",
    userId: b?.userId ?? "",
    accessToken: "",
    remainingPath: b?.remainingPath ?? "",
    usedPath: b?.usedPath ?? "",
    totalPath: b?.totalPath ?? "",
    divisor: b?.divisor ? String(b.divisor) : "",
    unit: b?.unit ?? "",
  };
}

function balanceOf(d: Draft): BalanceConfig | null {
  if (d.template === "none") return null;
  const out: BalanceConfig = { template: d.template };
  if (d.balanceUrl.trim()) out.url = d.balanceUrl.trim();
  if (d.template === "newapi" && d.userId.trim()) out.userId = d.userId.trim();
  if (d.template === "custom") {
    if (d.remainingPath.trim()) out.remainingPath = d.remainingPath.trim();
    if (d.usedPath.trim()) out.usedPath = d.usedPath.trim();
    if (d.totalPath.trim()) out.totalPath = d.totalPath.trim();
    if (d.divisor.trim()) out.divisor = Number(d.divisor);
    if (d.unit.trim()) out.unit = d.unit.trim();
  }
  return out;
}

export function ChannelDialog({ link, channel, kind = "claude", onClose, onSaved }: { link: HostLink; channel: ModelChannel | null; kind?: ChannelKind; onClose(): void; onSaved(c: ModelChannel, note?: string): void }) {
  const [d, setD] = useState<Draft>(() => draftOf(channel, kind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ChannelBalance | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const editing = !!channel;
  const amoKeys = AMO_CHANNEL_KEYS.filter((k) => k.kind === d.kind);
  const keyFromLabel = AMO_CHANNEL_KEYS.find((k) => k.id === d.keyFrom)?.label;

  async function save() {
    setBusy(true);
    setError(null);
    const input: ChannelInput = {
      label: d.label,
      baseUrl: d.baseUrl,
      model: d.model.trim() || null,
      balance: balanceOf(d),
      ...(d.kind === "claude" ? { smallModel: d.smallModel.trim() || null, claudeAuth: d.claudeAuth } : {}),
      ...(d.key.trim() ? { key: d.key.trim() } : { keyFrom: d.keyFrom }),
      ...(d.accessToken.trim() ? { accessToken: d.accessToken.trim() } : {}),
    };
    try {
      if (channel) {
        const saved = await call(link, "PATCH /api/channels/:id", { id: channel.id }, input);
        onSaved(saved, (saved as ModelChannel & { note?: string }).note);
      } else onSaved(await call(link, "POST /api/channels", {}, { ...input, kind: d.kind }));
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    const balance = balanceOf(d);
    if (!balance) return;
    setTest(null);
    setBusy(true);
    try {
      setTest(
        await call(link, "POST /api/channels/balance-test", {}, {
          ...(channel ? { id: channel.id } : {}),
          baseUrl: d.baseUrl,
          balance,
          ...(d.key.trim() ? { key: d.key.trim() } : d.keyFrom ? { keyFrom: d.keyFrom } : {}),
          ...(d.accessToken.trim() ? { accessToken: d.accessToken.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const tpl = BALANCE_TEMPLATES.find((t) => t.id === d.template);
  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="modal channel-modal" role="dialog" aria-modal="true" aria-labelledby="channel-title" data-testid="channel-dialog">
        <span className="modal-title" id="channel-title">
          {editing ? `编辑渠道「${channel.label}」` : "添加第三方渠道"}
        </span>
        {!editing && (
          <div className="kind-choices" role="radiogroup" aria-label="渠道类型">
            {(["claude", "codex", "dsh"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={d.kind === k} className="kind-choice" onClick={() => set({ kind: k, keyFrom: null })} data-testid={`channel-kind-${k}`}>
                {CHANNEL_KIND_LABEL[k]}
                <span className="kind-sub">{k === "claude" ? "用 Claude Code 跑" : k === "codex" ? "用 Codex 跑" : "用 DSH 跑"}</span>
              </button>
            ))}
          </div>
        )}
        <div className="channel-form">
          <label className="channel-field">
            <span>名字</span>
            <input ref={first} className="field" value={d.label} maxLength={40} onChange={(e) => set({ label: e.target.value })} placeholder={d.kind === "claude" ? "例如 中转 Claude" : d.kind === "dsh" ? "例如 中转 DeepSeek" : "例如 GPT-Dxx"} aria-label="渠道名字" data-testid="channel-label" />
          </label>
          <label className="channel-field">
            <span>网址</span>
            <input className="field mono" value={d.baseUrl} spellCheck={false} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={PLACEHOLDER[d.kind]} aria-label="渠道网址" data-testid="channel-url" />
          </label>
          <label className="channel-field">
            <span>API Key</span>
            <span className="channel-key">
              <input
                className="field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={d.key}
                onChange={(e) => set({ key: e.target.value })}
                placeholder={keyFromLabel ? `正在用${keyFromLabel}；粘贴新 Key 改用它` : channel?.keySaved ? "已保存；粘贴新 Key 以替换" : "sk-…"}
                aria-label="API Key"
                data-testid="channel-key"
              />
              {amoKeys.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className="chip small"
                  aria-pressed={d.keyFrom === k.id}
                  title={`不另存 Key，直接读旧 AMO 保存的那份（只读）${d.baseUrl ? "" : `；网址填 ${k.baseUrl}`}`}
                  onClick={() => set({ keyFrom: d.keyFrom === k.id ? null : k.id, key: "", ...(d.baseUrl ? {} : { baseUrl: k.baseUrl }) })}
                >
                  沿用{k.label}
                </button>
              ))}
            </span>
          </label>
          <label className="channel-field">
            <span>模型</span>
            <input className="field mono" value={d.model} spellCheck={false} onChange={(e) => set({ model: e.target.value })} placeholder={d.kind === "claude" ? "留空用 Claude Code 自己的；例如 claude-opus-5-5" : d.kind === "dsh" ? "留空用 DSH 默认的；例如 deepseek-v4-pro" : "留空用 Codex 默认的；例如 gpt-5.6-sol"} aria-label="模型" data-testid="channel-model" />
          </label>
          {d.kind === "dsh" && (
            <span className="settings-hint" data-testid="channel-dsh-hint">
              DSH 用 Anthropic 接口连 DeepSeek：网址要填第三方的 Anthropic 兼容地址（不是 /v1 的 OpenAI 接口）；模型名要和官方一致（deepseek-v4-pro、deepseek-v4-flash），DSH 只认这些。
            </span>
          )}
          {d.kind === "claude" && (
            <>
              <label className="channel-field">
                <span>快速模型</span>
                <input className="field mono" value={d.smallModel} spellCheck={false} onChange={(e) => set({ smallModel: e.target.value })} placeholder="后台小任务用的（ANTHROPIC_DEFAULT_HAIKU_MODEL），可留空" aria-label="快速模型" />
              </label>
              <div className="channel-field">
                <span>Key 的传法</span>
                <span className="settings-row">
                  {(
                    [
                      ["bearer", "Authorization: Bearer（多数中转）"],
                      ["x-api-key", "x-api-key（官方 API 风格）"],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} type="button" className="chip small" aria-pressed={d.claudeAuth === id} onClick={() => set({ claudeAuth: id })}>
                      {label}
                    </button>
                  ))}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="channel-balance">
          <span className="settings-label">余额查询</span>
          <div className="settings-row" role="radiogroup" aria-label="余额查询方式">
            {[{ id: "none" as const, label: "不查", hint: "不查询余额" }, ...BALANCE_TEMPLATES].map((t) => (
              <button key={t.id} type="button" role="radio" className="chip small" aria-checked={d.template === t.id} aria-pressed={d.template === t.id} title={t.hint} onClick={() => set({ template: t.id })} data-testid={`balance-${t.id}`}>
                {t.label}
              </button>
            ))}
          </div>
          {tpl && <span className="settings-hint">{tpl.hint}</span>}
          {(d.template === "newapi" || d.template === "sub2api" || d.template === "openai" || d.template === "general") && (
            <label className="channel-field">
              <span>{d.template === "newapi" ? "面板网址" : "查询网址"}</span>
              <input className="field mono" value={d.balanceUrl} spellCheck={false} onChange={(e) => set({ balanceUrl: e.target.value })} placeholder="留空用上面的网址" aria-label="查询网址" />
            </label>
          )}
          {d.template === "newapi" && (
            <>
              <label className="channel-field">
                <span>用户 ID</span>
                <input className="field" value={d.userId} onChange={(e) => set({ userId: e.target.value })} placeholder="面板 → 个人设置里的 ID" aria-label="用户 ID" />
              </label>
              <label className="channel-field">
                <span>系统访问令牌</span>
                <input className="field" type="password" autoComplete="off" value={d.accessToken} onChange={(e) => set({ accessToken: e.target.value })} placeholder={channel?.accessTokenSaved ? "已保存；粘贴新令牌以替换" : "面板 → 个人设置 → 生成系统访问令牌"} aria-label="系统访问令牌" />
              </label>
            </>
          )}
          {d.template === "custom" && (
            <>
              <label className="channel-field">
                <span>查询地址</span>
                <input className="field mono" value={d.balanceUrl} spellCheck={false} onChange={(e) => set({ balanceUrl: e.target.value })} placeholder="{{baseUrl}}/api/balance（GET，自动带 Bearer Key）" aria-label="查询地址" data-testid="balance-url" />
              </label>
              <div className="channel-paths">
                <input className="field mono" value={d.remainingPath} onChange={(e) => set({ remainingPath: e.target.value })} placeholder="剩余：data.balance" aria-label="剩余的位置" data-testid="balance-remaining-path" />
                <input className="field mono" value={d.usedPath} onChange={(e) => set({ usedPath: e.target.value })} placeholder="已用：data.used" aria-label="已用的位置" />
                <input className="field mono" value={d.totalPath} onChange={(e) => set({ totalPath: e.target.value })} placeholder="总额：data.total" aria-label="总额的位置" />
                <input className="field" value={d.divisor} onChange={(e) => set({ divisor: e.target.value })} placeholder="除以（可空）" aria-label="除数" />
                <input className="field" value={d.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="单位 USD" aria-label="单位" />
              </div>
            </>
          )}
          {d.template !== "none" && (
            <div className="settings-row">
              <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void runTest()} data-testid="balance-test">
                测试查询
              </button>
              {test && (
                <span className={test.ok ? "credential-state saved" : "form-error"} role="status" data-testid="balance-test-result">
                  {balanceText(test)}
                </span>
              )}
            </div>
          )}
        </div>

        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <span className="settings-hint">Key 和令牌只存进 Windows 凭据管理器；Studio 启动会话时放进它的环境变量，不写任何文件。</span>
        <div className="settings-row end">
          <button type="button" className="btn-ghost small" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary small" disabled={busy || !d.label.trim() || !d.baseUrl.trim()} onClick={() => void save()} data-testid="channel-save">
            {editing ? "保存" : "添加"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
