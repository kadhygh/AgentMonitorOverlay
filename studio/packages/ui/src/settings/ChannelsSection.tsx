import { useEffect, useState, type ReactNode } from "react";
import { CHANNEL_KIND_LABEL, RUNTIME_LABELS, type ChannelKind, type CredentialStatus, type ModelChannel, type ModelProfile, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { balanceText, useBalance } from "../lib/balance.js";
import { Mark } from "../chat/pickers.js";
import { CredentialMessage, type SettingsMessage } from "./CredentialsSection.js";
import { ModelDefaultsSection } from "./ModelDefaultsSection.js";
import { AutoCompactSection } from "./AutoCompactSection.js";

// 设置 → 模型 → 渠道. S18 (2026-10-18): a list on the left, in two parts — 支持的渠道 (built in) and 第三方 (the person's
// own Claude and Codex endpoints, added as one or the other) — and the chosen channel's page on the right: what it runs
// on, its key and balance, 「在模型选择里隐藏」, its sign-in or DSH clone (`extra`), the order and defaults of its models,
// and its own 自动压缩点.

/** What a built-in channel is, in a few words. */
const BUILTIN_SUB: Record<string, string> = {
  "codex-default": "Codex · 本机 Codex 的登录（ChatGPT 订阅）",
  "codex-deepseek-flash": "Codex · DeepSeek 官方接口",
  "claude-glm": "Claude Code · 智谱 GLM Coding Plan",
  "claude-subscription": "Claude Code · Claude 订阅",
  "dsh-deepseek": "DSH · DeepSeek 官方接口（DeepSeek Harness 源码）",
};

/** A third-party channel's scheme, as the list and the page call it. */
export const SCHEME: Record<ChannelKind, string> = { codex: "Codex 方案", claude: "Claude 方案", dsh: "DSH 方案" };

function subOf(p: ModelProfile, c: ModelChannel | undefined): string {
  if (c) return `${CHANNEL_KIND_LABEL[c.kind]} · ${c.baseUrl.replace(/^https?:\/\//, "")}`;
  return BUILTIN_SUB[p.id] ?? (p.runtime === "claude" ? "Claude Code" : RUNTIME_LABELS[p.runtime]);
}

/** The person's own channels, following `profiles.updated`. */
export function useChannels(link: HostLink): [ModelChannel[], () => void] {
  const [list, setList] = useState<ModelChannel[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    call(link, "GET /api/channels")
      .then((l) => live && setList(l))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link, tick]);
  useEffect(() => onHostEvent((e) => e.type === "profiles.updated" && setTick((t) => t + 1)), []);
  return [list, () => setTick((t) => t + 1)];
}

/** One row of the list on the left. */
export function ChannelNavItem({ profile, channel, selected, onSelect }: { profile: ModelProfile; channel: ModelChannel | undefined; selected: boolean; onSelect(): void }) {
  const note = channel ? SCHEME[channel.kind] : RUNTIME_LABELS[profile.runtime];
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      className={`models-nav-item${profile.hidden ? " hidden" : ""}`}
      onClick={onSelect}
      title={profile.hidden ? `${profile.label}（已隐藏）` : profile.label}
      data-testid="channel-nav"
      data-id={profile.id}
    >
      <Mark profile={profile} />
      <span className="models-nav-text">
        <span className="models-nav-name">{profile.label}</span>
        <span className="models-nav-sub">
          {note}
          {profile.hidden ? " · 已隐藏" : ""}
        </span>
      </span>
    </button>
  );
}

/** The chosen channel's page. */
export function ChannelPage({
  link,
  settings,
  profile,
  channel,
  credentials,
  extra,
  onEdit,
  onRemoved,
}: {
  link: HostLink;
  settings: StudioSettings | null;
  profile: ModelProfile;
  channel: ModelChannel | undefined;
  credentials: readonly CredentialStatus[] | null;
  extra?: ReactNode;
  onEdit(c: ModelChannel): void;
  onRemoved(c: ModelChannel): void;
}) {
  const { balance, loading, refresh } = useBalance(link, profile);
  const [message, setMessage] = useState<SettingsMessage>(null);
  const [confirm, setConfirm] = useState(false);
  // Shown at once; the Host's profiles.updated (or a refusal) settles it.
  const [hidden, setHidden] = useState(!!profile.hidden);
  useEffect(() => setHidden(!!profile.hidden), [profile.hidden]);
  useEffect(() => {
    setMessage(null);
    setConfirm(false);
  }, [profile.id]);

  const cred = profile.credentialId && !profile.custom ? credentials?.find((x) => x.id === profile.credentialId) : undefined;
  const keyState = channel
    ? channel.keyFrom
      ? `Key：沿用旧 AMO 的 ${channel.keyFrom.toUpperCase()}`
      : channel.keySaved
        ? "Key 已保存"
        : "Key 未设置"
    : cred && !cred.writable
      ? cred.saved
        ? "Key 已保存（旧 AMO 设置里的）"
        : "Key 未设置：在旧 AMO 设置里保存"
      : null;
  const keyOk = channel ? channel.keySaved : !!cred?.saved;

  async function toggleHidden(next: boolean) {
    setHidden(next);
    setMessage(null);
    try {
      await call(link, "PUT /api/profiles/:id/hidden", { id: profile.id }, { hidden: next });
    } catch (err) {
      setHidden(!!profile.hidden);
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    }
  }

  async function remove(c: ModelChannel) {
    setMessage(null);
    try {
      await call(link, "DELETE /api/channels/:id", { id: c.id });
      onRemoved(c);
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    }
  }

  return (
    <div className="channel-page" data-testid="channel-page" data-id={profile.id}>
      <section className="settings-section" aria-label="连接">
        <div className="channel-head">
          <Mark profile={profile} />
          <span className="channel-name">
            <b data-testid="channel-title">{profile.label}</b>
            <span className="channel-sub" title={channel?.baseUrl}>
              {subOf(profile, channel)}
            </span>
          </span>
          <label className="channel-hide" title="在新建任务、新会话等处的模型选择里不列出这个渠道；已经在用它的会话照常">
            <input type="checkbox" checked={hidden} onChange={(e) => void toggleHidden(e.target.checked)} aria-label={`在模型选择里隐藏 ${profile.label}`} data-testid="channel-hidden" />
            在模型选择里隐藏
          </label>
        </div>
        {(keyState || channel || profile.balance) && (
          <div className="channel-meta">
            {channel && <span className="scheme-chip">{SCHEME[channel.kind]}</span>}
            {keyState && <span className={`credential-state${keyOk ? " saved" : ""}`}>{keyState}</span>}
            {channel?.model && <span className="channel-model mono">{channel.model}</span>}
            {profile.balance && (
              <button type="button" className={`balance-chip${balance && !balance.ok ? " bad" : ""}`} disabled={loading} onClick={refresh} title={balance ? `${balanceText(balance)}\n查询于 ${new Date(balance.checkedAt).toLocaleTimeString()}；点击重新查询` : "查询余额"} data-testid="channel-balance">
                {loading ? "查询中…" : balance ? balanceText(balance) : "查余额"}
              </button>
            )}
            <span className="spacer" />
            {channel && (
              <button type="button" className="btn-ghost small" onClick={() => onEdit(channel)} data-testid="channel-edit">
                编辑
              </button>
            )}
            {channel &&
              (confirm ? (
                <>
                  <button type="button" className="btn-danger small" onClick={() => void remove(channel)} data-testid="channel-remove-confirm">
                    确认删除
                  </button>
                  <button type="button" className="btn-ghost small" onClick={() => setConfirm(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" className="btn-ghost small" onClick={() => setConfirm(true)} data-testid="channel-remove">
                  删除
                </button>
              ))}
          </div>
        )}
        <CredentialMessage message={message} />
        {extra && <div className="channel-extra">{extra}</div>}
      </section>
      <ModelDefaultsSection key={`defaults-${profile.id}`} link={link} settings={settings} profileId={profile.id} />
      <AutoCompactSection key={`compact-${profile.id}`} link={link} settings={settings} profile={profile} />
    </div>
  );
}
