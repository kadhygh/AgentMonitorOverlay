import { useEffect, useState, type ReactNode } from "react";
import { CHANNEL_KIND_LABEL, type ChannelKind, type CredentialStatus, type ModelChannel, type ModelProfile } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { balanceText, useBalance } from "../lib/balance.js";
import { Mark } from "../chat/pickers.js";
import { ChannelDialog } from "./ChannelDialog.js";
import { CredentialMessage, type SettingsMessage } from "./CredentialsSection.js";

// 设置 → 模型 → 渠道 (2026-10-15): one card per channel — the built-in ones and the person's own third-party Claude and
// Codex endpoints — with what it runs on, whether its key is saved, its balance where the site tells it, and
// 「在模型选择里隐藏」. A card's extra part (the Claude subscription's sign-in) comes from `extra`.

/** What a built-in channel is, in a few words. */
const BUILTIN_SUB: Record<string, string> = {
  "codex-default": "Codex · 本机 Codex 的登录（ChatGPT 订阅）",
  "codex-deepseek-flash": "Codex · DeepSeek 官方接口",
  "claude-glm": "Claude Code · 智谱 GLM Coding Plan",
  "claude-subscription": "Claude Code · Claude 订阅",
};

function subOf(p: ModelProfile, c: ModelChannel | undefined): string {
  if (c) return `${CHANNEL_KIND_LABEL[c.kind]} · ${c.baseUrl.replace(/^https?:\/\//, "")}`;
  return BUILTIN_SUB[p.id] ?? (p.runtime === "codex" ? "Codex" : "Claude Code");
}

/** The person's own channels, following `profiles.updated`. */
function useChannels(link: HostLink): [ModelChannel[], () => void] {
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

export function ChannelsSection({ link, profiles, credentials, extra }: { link: HostLink; profiles: readonly ModelProfile[]; credentials: readonly CredentialStatus[] | null; extra?: Record<string, ReactNode> }) {
  const [channels, reload] = useChannels(link);
  const [dialog, setDialog] = useState<{ channel: ModelChannel | null; kind: ChannelKind } | null>(null);
  const [message, setMessage] = useState<SettingsMessage>(null);

  async function setHidden(p: ModelProfile, hidden: boolean): Promise<boolean> {
    setMessage(null);
    try {
      await call(link, "PUT /api/profiles/:id/hidden", { id: p.id }, { hidden });
      return true;
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return false;
    }
  }

  async function remove(c: ModelChannel) {
    setMessage(null);
    try {
      await call(link, "DELETE /api/channels/:id", { id: c.id });
      setMessage({ text: `已删除渠道「${c.label}」` });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    }
  }

  return (
    <section className="settings-section" aria-label="渠道">
      <div className="settings-row">
        <span className="settings-heading">渠道</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={() => setDialog({ channel: null, kind: "claude" })} data-testid="channel-add">
          + 添加渠道
        </button>
      </div>
      <span className="settings-hint">勾选「隐藏」后，新建任务、新会话、预设等处的模型选择里就不再列出它；已经在用它的会话照常。</span>
      <div className="channel-list">
        {profiles.map((p) => {
          const c = channels.find((x) => x.id === p.id);
          const cred = p.credentialId && !p.custom ? credentials?.find((x) => x.id === p.credentialId) : undefined;
          return (
            <ChannelCard
              key={p.id}
              link={link}
              profile={p}
              channel={c}
              sub={subOf(p, c)}
              keyState={c ? (c.keyFrom ? `Key：沿用旧 AMO 的 ${c.keyFrom.toUpperCase()}` : c.keySaved ? "Key 已保存" : "Key 未设置") : cred && !cred.writable ? (cred.saved ? "Key 已保存（旧 AMO 设置里的）" : "Key 未设置：在旧 AMO 设置里保存") : null}
              keyOk={c ? c.keySaved : !!cred?.saved}
              onHidden={(h) => setHidden(p, h)}
              onEdit={c ? () => setDialog({ channel: c, kind: c.kind }) : undefined}
              onRemove={c ? () => void remove(c) : undefined}
            >
              {extra?.[p.id]}
            </ChannelCard>
          );
        })}
      </div>
      <CredentialMessage message={message} />
      {dialog && (
        <ChannelDialog
          link={link}
          channel={dialog.channel}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onSaved={(c, note) => {
            setDialog(null);
            reload();
            setMessage({ text: note ?? (dialog.channel ? `已保存渠道「${c.label}」` : `已添加渠道「${c.label}」，新建任务和新会话里可以选它了`) });
          }}
        />
      )}
    </section>
  );
}

function ChannelCard({
  link,
  profile,
  channel,
  sub,
  keyState,
  keyOk,
  onHidden,
  onEdit,
  onRemove,
  children,
}: {
  link: HostLink;
  profile: ModelProfile;
  channel: ModelChannel | undefined;
  sub: string;
  keyState: string | null;
  keyOk: boolean;
  onHidden(hidden: boolean): Promise<boolean>;
  onEdit?: () => void;
  onRemove?: () => void;
  children?: ReactNode;
}) {
  const { balance, loading, refresh } = useBalance(link, profile);
  const [confirm, setConfirm] = useState(false);
  // Shown at once; the Host's profiles.updated (or a refusal) settles it.
  const [hidden, setHidden] = useState(!!profile.hidden);
  useEffect(() => setHidden(!!profile.hidden), [profile.hidden]);
  return (
    <div className={`channel-card${hidden ? " hidden" : ""}`} data-testid="channel-card" data-id={profile.id}>
      <div className="channel-head">
        <Mark profile={profile} />
        <span className="channel-name">
          <b>{profile.label}</b>
          <span className="channel-sub" title={channel?.baseUrl}>
            {sub}
          </span>
        </span>
        <label className="channel-hide" title="在新建任务、新会话等处的模型选择里不列出这个渠道">
          <input type="checkbox" checked={hidden} onChange={(e) => {
              setHidden(e.target.checked);
              void onHidden(e.target.checked).then((ok) => !ok && setHidden(!!profile.hidden));
            }} aria-label={`在模型选择里隐藏 ${profile.label}`} data-testid="channel-hidden" />
          隐藏
        </label>
      </div>
      {(keyState || channel?.model || profile.balance || onEdit) && (
        <div className="channel-meta">
          {keyState && <span className={`credential-state${keyOk ? " saved" : ""}`}>{keyState}</span>}
          {channel?.model && <span className="channel-model mono">{channel.model}</span>}
          {profile.balance && (
            <button type="button" className={`balance-chip${balance && !balance.ok ? " bad" : ""}`} disabled={loading} onClick={refresh} title={balance ? `${balanceText(balance)}\n查询于 ${new Date(balance.checkedAt).toLocaleTimeString()}；点击重新查询` : "查询余额"} data-testid="channel-balance">
              {loading ? "查询中…" : balance ? balanceText(balance) : "查余额"}
            </button>
          )}
          <span className="spacer" />
          {onEdit && (
            <button type="button" className="btn-ghost small" onClick={onEdit} data-testid="channel-edit">
              编辑
            </button>
          )}
          {onRemove &&
            (confirm ? (
              <>
                <button type="button" className="btn-danger small" onClick={onRemove} data-testid="channel-remove-confirm">
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
      {children && <div className="channel-extra">{children}</div>}
    </div>
  );
}
