import { useState } from "react";
import type { ChannelKind, ModelChannel, StudioSettings } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { CredentialMessage, useCredentials, type SettingsMessage } from "./CredentialsSection.js";
import { PresetsSection } from "./PresetsSection.js";
import { ChannelNavItem, ChannelPage, SCHEME, useChannels } from "./ChannelsSection.js";
import { ChannelDialog } from "./ChannelDialog.js";
import { QuickModelsSection } from "./QuickModelsSection.js";
import { DshSection } from "./DshSection.js";
import { ClaudeCodeSection } from "./ClaudeCodeSection.js";
import { useProfiles } from "../lib/balance.js";

/** What each 「+ … 方案」 adds. */
const ADD_HINT = {
  codex: "添加一个用 Codex 跑的第三方接口（OpenAI 兼容）",
  claude: "添加一个用 Claude Code 跑的第三方接口（Anthropic 兼容）",
  dsh: "添加一个用 DSH 跑的第三方 DeepSeek（要 Anthropic 兼容的地址，模型名和官方一致）",
} as const;

// 设置 → 模型. S18 (2026-10-18): a list on the left — 支持的渠道 (built in), 第三方 (the person's own endpoints, each run
// as a Codex or a Claude one; added from the two buttons under them), then 快速选择 and 常用预设, which belong to no
// channel — and the chosen entry on the right. A channel's page holds everything about it: key, balance, hiding, the
// Claude subscription's sign-in or the DSH clone, the order and defaults of its models, and its 自动压缩点.

/** The built-in Claude subscription channel: it signs in through the person's own Claude Code. */
const CLAUDE_SUBSCRIPTION = "claude-subscription";

type View = { kind: "channel"; id: string } | { kind: "quick" } | { kind: "presets" };

/** What was open last: 设置 opens on it again (for this window). */
let lastView: View | null = null;

export function ModelsPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const [list] = useCredentials(link);
  const profiles = useProfiles(link);
  const [channels, reloadChannels] = useChannels(link);
  const [view, setViewState] = useState<View | null>(lastView);
  const setView = (v: View | null) => {
    lastView = v;
    setViewState(v);
  };
  const [dialog, setDialog] = useState<{ channel: ModelChannel | null; kind: ChannelKind } | null>(null);
  const [message, setMessage] = useState<SettingsMessage>(null);
  if (!profiles) return <span className="settings-hint">正在读取渠道…</span>;

  const builtin = profiles.filter((p) => !p.custom);
  const custom = profiles.filter((p) => p.custom);
  // The chosen channel, or the first one when nothing (or a channel since removed) is chosen.
  const chosen = view?.kind === "channel" ? profiles.find((p) => p.id === view.id) : undefined;
  const current: View = view && (view.kind !== "channel" || chosen) ? view : profiles[0] ? { kind: "channel", id: profiles[0].id } : { kind: "quick" };
  const profile = current.kind === "channel" ? profiles.find((p) => p.id === current.id) : undefined;
  const channel = profile ? channels.find((c) => c.id === profile.id) : undefined;

  // A channel on Claude Code: which one it runs on (none in the portable build until installed), and the Claude
  // subscription's sign-in; DeepSeek on DSH's own harness (stage 17): where the clone is, and 「检查」.
  const extra =
    profile?.runtime === "claude" ? (
      <>
        <ClaudeCodeSection link={link} />
        {!profile.custom && profile.id === CLAUDE_SUBSCRIPTION && settings && <ClaudeLoginSection settings={settings} />}
      </>
    ) : profile && !profile.custom && profile.runtime === "dsh" ? (
      <DshSection link={link} />
    ) : undefined;

  const select = (v: View) => {
    setView(v);
    setMessage(null);
  };

  return (
    <div className="models-layout">
      <nav className="models-nav" aria-label="渠道">
        <span className="models-nav-group">支持的渠道</span>
        {builtin.map((p) => (
          <ChannelNavItem key={p.id} profile={p} channel={undefined} selected={current.kind === "channel" && current.id === p.id} onSelect={() => select({ kind: "channel", id: p.id })} />
        ))}
        <span className="models-nav-group">第三方</span>
        {custom.map((p) => (
          <ChannelNavItem key={p.id} profile={p} channel={channels.find((c) => c.id === p.id)} selected={current.kind === "channel" && current.id === p.id} onSelect={() => select({ kind: "channel", id: p.id })} />
        ))}
        {(["codex", "claude", "dsh"] as const).map((k) => (
          <button key={k} type="button" className="models-nav-add" onClick={() => setDialog({ channel: null, kind: k })} title={ADD_HINT[k]} data-testid={`channel-add-${k}`}>
            + {SCHEME[k]}
          </button>
        ))}
        <span className="models-nav-sep" aria-hidden="true" />
        <button type="button" aria-current={current.kind === "quick" ? "page" : undefined} className="models-nav-item plain" onClick={() => select({ kind: "quick" })} data-testid="models-nav-quick">
          快速选择
        </button>
        <button type="button" aria-current={current.kind === "presets" ? "page" : undefined} className="models-nav-item plain" onClick={() => select({ kind: "presets" })} data-testid="models-nav-presets">
          常用预设
        </button>
      </nav>
      <div className="models-detail" key={current.kind === "channel" ? current.id : current.kind}>
        <CredentialMessage message={message} />
        {profile && (
          <ChannelPage
            link={link}
            settings={settings}
            profile={profile}
            channel={channel}
            credentials={list}
            extra={extra}
            onEdit={(c) => setDialog({ channel: c, kind: c.kind })}
            onRemoved={(c) => {
              setView(null);
              setMessage({ text: `已删除渠道「${c.label}」` });
            }}
          />
        )}
        {current.kind === "quick" && <QuickModelsSection link={link} settings={settings} profiles={profiles} />}
        {current.kind === "presets" && <PresetsSection link={link} presets={settings?.presets ?? []} />}
      </div>
      {dialog && (
        <ChannelDialog
          link={link}
          channel={dialog.channel}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onSaved={(c, note) => {
            const added = !dialog.channel;
            setDialog(null);
            reloadChannels();
            setView({ kind: "channel", id: c.id });
            setMessage({ text: note ?? (added ? `已添加渠道「${c.label}」，新建任务和新会话里可以选它了` : `已保存渠道「${c.label}」`) });
          }}
        />
      )}
    </div>
  );
}

/**
 * The Claude subscription's sign-in: the person's own Claude Code login, the only way since 2026-10-27 (the
 * `claude setup-token` token mode is gone, so Studio keeps no Claude.ai credential). Shown with what that means.
 */
function ClaudeLoginSection({ settings }: { settings: StudioSettings }) {
  const local = settings.claudeLocal;
  return (
    <div className="claude-login" aria-label="Claude 订阅">
      <span className="settings-hint">用本机 Claude Code 的登录：和终端里的 claude 同一个账号、同一份用量额度。要换账号或重新登录，在终端运行 claude 即可。</span>
      <div className="settings-row" data-testid="claude-local-state">
        <span className="settings-label">本机登录</span>
        <span className={`credential-state${local.signedIn ? " saved" : ""}`}>{local.signedIn === null ? "无法检测" : local.signedIn ? "已找到" : "没找到：先在终端运行 claude 登录一次"}</span>
        <code className="login-dir" title={local.dir}>
          {local.dir}
        </code>
      </div>
      <ul className="settings-hint claude-login-notes" data-testid="claude-login-notes">
        <li>
          Studio 的对话记录写进 <code>{local.dir}\projects</code>，和你终端的会话放在一起，<code>claude --resume</code> 的列表里也看得到。
        </li>
        <li>和终端里一样，会加载那里的 settings.json、CLAUDE.md、自定义命令、skills 和 hooks；MCP 服务器只用 Studio 自己的。</li>
        <li>左下角的 Claude 用量读这份登录去查额度（只读）。</li>
      </ul>
    </div>
  );
}
