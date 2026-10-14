import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClaudeLogin, CredentialStatus, StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { CredentialMessage, CredentialRow, CredentialsSection, useCredentials, type SettingsMessage } from "./CredentialsSection.js";
import { PresetsSection } from "./PresetsSection.js";
import { ModelDefaultsSection } from "./ModelDefaultsSection.js";

// 设置 → 模型: how the Claude subscription signs in (a token, or the person's own Claude Code login after a warning),
// the order and defaults of each profile's models, the other models' keys, and the 常用预设.

const CLAUDE_CREDENTIAL = "claude-subscription";

export function ModelsPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const [list, setList] = useCredentials(link);
  const claude = list?.find((c) => c.id === CLAUDE_CREDENTIAL);
  const others = list?.filter((c) => c.id !== CLAUDE_CREDENTIAL) ?? [];
  return (
    <>
      {claude && settings && <ClaudeLoginSection link={link} settings={settings} credential={claude} onCredentials={setList} />}
      <ModelDefaultsSection link={link} settings={settings} />
      <CredentialsSection link={link} list={others} onChange={setList} />
      <PresetsSection link={link} presets={settings?.presets ?? []} />
    </>
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
    <section className="settings-section" aria-label="Claude 订阅">
      <span className="settings-heading">Claude 订阅</span>
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
    </section>
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
          <li>Studio 仍按自己的方式启动 Claude：不加载那里的 settings.json、hooks、CLAUDE.md 和你配置的 MCP 服务器。</li>
          <li>只适合你自己在这台电脑上用。把 AMO 打包给别人时不要用这种方式：Anthropic 不允许第三方产品让用户用 claude.ai 账号登录。</li>
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
