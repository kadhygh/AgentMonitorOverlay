import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChannelKind, ClaudeLogin, CredentialStatus, ModelChannel, StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { CredentialMessage, CredentialRow, useCredentials, type SettingsMessage } from "./CredentialsSection.js";
import { PresetsSection } from "./PresetsSection.js";
import { ChannelNavItem, ChannelPage, SCHEME, useChannels } from "./ChannelsSection.js";
import { ChannelDialog } from "./ChannelDialog.js";
import { QuickModelsSection } from "./QuickModelsSection.js";
import { DshSection } from "./DshSection.js";
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

const CLAUDE_CREDENTIAL = "claude-subscription";

type View = { kind: "channel"; id: string } | { kind: "quick" } | { kind: "presets" };

/** What was open last: 设置 opens on it again (for this window). */
let lastView: View | null = null;

export function ModelsPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const [list, setList] = useCredentials(link);
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
  const claude = list?.find((c) => c.id === CLAUDE_CREDENTIAL);

  // The Claude subscription's sign-in, and DeepSeek on DSH's own harness (stage 17): where the clone is, and 「检查」.
  const extra =
    profile && !profile.custom && profile.credentialId === CLAUDE_CREDENTIAL && claude && settings ? (
      <ClaudeLoginSection link={link} settings={settings} credential={claude} onCredentials={setList} />
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

const LOGINS: Array<{ id: ClaudeLogin; label: string; hint: string }> = [
  { id: "token", label: "令牌（推荐）", hint: "用 claude setup-token 生成的长期令牌。Studio 用自己的配置目录，和你终端里的 Claude Code 互不影响。" },
  { id: "local", label: "本机 Claude Code 的登录", hint: "和终端里的 claude 用同一个登录，不用另外弄令牌；左下角能看到 Claude 的用量百分比。" },
];

function ClaudeLoginSection({ link, settings, credential, onCredentials }: { link: HostLink; settings: StudioSettings; credential: CredentialStatus; onCredentials(list: CredentialStatus[]): void }) {
  const [shown, setShown] = useState<ClaudeLogin>(settings.claudeLogin);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SettingsMessage>(null);
  useEffect(() => setShown(settings.claudeLogin), [settings.claudeLogin]);

  async function save(login: ClaudeLogin) {
    setShown(login);
    setBusy(true);
    setMessage(null);
    try {
      await call(link, "PUT /api/settings", {}, { claudeLogin: login });
      setMessage({ text: login === "local" ? "已改用本机 Claude Code 的登录：之后新开的 Claude 会话生效" : "已改用令牌：之后新开的 Claude 会话生效" });
    } catch (err) {
      setShown(settings.claudeLogin);
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  function pick(login: ClaudeLogin) {
    if (login === shown || busy) return;
    // Using the person's own login is theirs to decide with the risks in front of them.
    if (login === "local") setConfirming(true);
    else void save(login);
  }

  const local = settings.claudeLocal;
  return (
    <div className="claude-login" aria-label="Claude 订阅">
      <div role="radiogroup" aria-label="Claude 登录方式" className="login-choices">
        {LOGINS.map((l) => (
          <button key={l.id} type="button" role="radio" aria-checked={shown === l.id} className="login-choice" aria-label={l.label} aria-describedby={`claude-login-hint-${l.id}`} disabled={busy} onClick={() => pick(l.id)} data-testid={`claude-login-${l.id}`}>
            <span className="login-dot" aria-hidden="true" />
            <span className="login-text">
              <span className="login-label">{l.label}</span>
              <span className="settings-hint" id={`claude-login-hint-${l.id}`}>
                {l.hint}
              </span>
            </span>
          </button>
        ))}
      </div>
      {shown === "token" ? (
        <CredentialRow link={link} credential={credential} label="令牌" onChange={onCredentials} onMessage={setMessage} />
      ) : (
        <div className="settings-row" data-testid="claude-local-state">
          <span className="settings-label">本机登录</span>
          <span className={`credential-state${local.signedIn ? " saved" : ""}`}>{local.signedIn === null ? "无法检测" : local.signedIn ? "已找到" : "没找到：先在终端运行 claude 登录一次"}</span>
          <code className="login-dir" title={local.dir}>
            {local.dir}
          </code>
        </div>
      )}
      <span className="settings-hint">只影响之后新开的 Claude 会话；已有的会话继续用它开始时的方式。</span>
      <CredentialMessage message={message} />
      {confirming && (
        <LocalLoginConfirm
          dir={local.dir}
          signedIn={local.signedIn}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void save("local");
          }}
        />
      )}
    </div>
  );
}

/** The second dialog, over 设置: what changes when Studio's Claude uses the person's own Claude Code. */
function LocalLoginConfirm({ dir, signedIn, onCancel, onConfirm }: { dir: string; signedIn: boolean | null; onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => {
        // Escape closes this dialog only, not 设置 underneath.
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="local-login-title" aria-describedby="local-login-risks" data-testid="claude-local-confirm">
        <span className="modal-title" id="local-login-title">
          改用本机 Claude Code 的登录？
        </span>
        <ul className="confirm-risks" id="local-login-risks">
          <li>
            Studio 的 Claude 会话会用你本机 Claude Code 的登录和数据目录 <code>{dir}</code>。
          </li>
          <li>和终端里的 claude 共用同一个账号和用量额度。在终端退出登录、换账号或登录过期，Studio 里的 Claude 也会一起断掉。</li>
          <li>左下角的 Claude 用量会读取那里的登录信息去查账号额度（只读，不修改）。</li>
          <li>
            Studio 的对话记录会写进 <code>{dir}\projects</code>，和你终端的会话放在一起，<code>claude --resume</code> 的列表里也会看到。
          </li>
          <li>和终端里一样，会加载那里的 settings.json、CLAUDE.md、自定义命令和 skills；你配置的 hooks 也会在 Studio 的会话里运行。只有 MCP 服务器例外：只用 Studio 自己的，不用你配置的。</li>
          <li>按 Anthropic 帮助中心的说明（2026-06 起），Agent SDK 和第三方应用可以用订阅额度，Studio 的 Claude 会话会计入你的订阅用量。政策以后可能再变，以官方说明为准；把 AMO 给别人用时，让他们用自己的账号登录。</li>
          <li>已有的 Claude 会话不受影响；之后新开的才用本机登录。随时可以改回令牌。</li>
        </ul>
        {signedIn === false && (
          <span className="form-error" role="alert">
            现在没找到本机登录。改好后先在终端运行 claude 登录一次，否则 Claude 会话开不起来。
          </span>
        )}
        <div className="settings-row end">
          <button ref={cancel} type="button" className="btn-ghost small" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-danger small" onClick={onConfirm}>
            我了解风险，改用本机登录
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
