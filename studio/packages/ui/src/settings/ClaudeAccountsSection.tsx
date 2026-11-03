import { useEffect, useState } from "react";
import type { ClaudeAccount, ClaudeAccountsState, StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 模型 → Claude 订阅 (Claude 多账号, 2026-11-03, the user: 登录多账号在设置界面做). Each account is a Claude Code
// config dir of its own, signed in with Claude Code's own `auth login` (Studio keeps no Claude.ai credential); the
// added ones share the default dir's conversation records, so a session goes on under whichever account is current.
// Switching is refused while a Claude session is at work.

const PLAN: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };

export function ClaudeAccountsSection({ link, settings }: { link: HostLink; settings: StudioSettings }) {
  // Every change reaches here with the settings; the page also reads the list when it opens (a login made in a terminal,
  // or one gone, shows at once) and after each action.
  const [state, setState] = useState<ClaudeAccountsState>(settings.claudeAccounts);
  useEffect(() => setState(settings.claudeAccounts), [settings.claudeAccounts]);
  useEffect(() => {
    call(link, "GET /api/claude-accounts")
      .then(setState)
      .catch(() => undefined);
  }, [link]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const local = settings.claudeLocal;

  async function act(key: string, fn: () => Promise<ClaudeAccountsState>, done?: string) {
    setBusy(key);
    setMessage(null);
    try {
      setState(await fn());
      if (done) setMessage({ text: done });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  const current = state.accounts.find((a) => a.id === state.current);
  return (
    <div className="claude-login" aria-label="Claude 订阅" data-testid="claude-accounts">
      <span className="settings-hint">
        用本机 Claude Code 的登录。可以登录多个账号（每个账号一个独立的配置目录，Claude Code 官方的多账号做法），在这里或左下角的额度里切换；Claude 订阅的会话都用「正在使用」的那个账号。
      </span>
      <div className="claude-accounts" role="list">
        {state.accounts.map((a) => (
          <AccountRow
            key={a.id}
            link={link}
            account={a}
            current={a.id === state.current}
            switchBlocked={state.switchBlocked}
            busy={busy}
            act={act}
          />
        ))}
      </div>
      {adding ? (
        <form
          className="claude-account-add"
          onSubmit={(e) => {
            e.preventDefault();
            void act("add", () => call(link, "POST /api/claude-accounts", {}, { label }), "已开始登录：在打开的浏览器里登录要添加的账号").then(() => {
              setAdding(false);
              setLabel("");
            });
          }}
        >
          <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名字（可不填，默认用账号邮箱）" maxLength={60} aria-label="账号名字" data-testid="claude-account-label" autoFocus />
          <button type="submit" className="btn-primary small" disabled={busy === "add"} data-testid="claude-account-add-go">
            {busy === "add" ? "正在启动…" : "登录"}
          </button>
          <button type="button" className="btn-ghost small" onClick={() => setAdding(false)}>
            取消
          </button>
        </form>
      ) : (
        <div className="settings-row">
          <button type="button" className="btn-ghost small" onClick={() => setAdding(true)} data-testid="claude-account-add">
            + 添加账号
          </button>
          {state.switchBlocked && (
            <span className="settings-hint" data-testid="claude-switch-blocked">
              {state.switchBlocked}
            </span>
          )}
        </div>
      )}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : undefined}>
          {message.text}
        </span>
      )}
      <ul className="settings-hint claude-login-notes" data-testid="claude-login-notes">
        <li>
          对话记录写进 <code>{local.dir}\projects</code>，和你终端的会话放在一起；添加的账号也用这一份（链接过去），所以切换账号后会话能接着聊，Claude 的记忆也是同一份。
        </li>
        <li>添加的账号沿用默认账号的 CLAUDE.md、settings.json、skills 和插件（以默认账号的为准）；MCP 服务器只用 Studio 自己的。</li>
        <li>有 Claude 会话正在进行时不能切换；切换后，空闲会话的下一条消息就用新账号。{current ? `现在用的是「${current.label}」。` : ""}</li>
        <li>左下角的额度按账号分开显示，各读各的登录（只读）。</li>
      </ul>
    </div>
  );
}

function AccountRow({
  link,
  account: a,
  current,
  switchBlocked,
  busy,
  act,
}: {
  link: HostLink;
  account: ClaudeAccount;
  current: boolean;
  switchBlocked: string | null;
  busy: string | null;
  act(key: string, fn: () => Promise<ClaudeAccountsState>, done?: string): Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const signedIn = a.signedIn !== false;
  const waiting = a.login?.state === "waiting";
  const sub = [a.email && a.email !== a.label ? a.email : null, a.plan ? (PLAN[a.plan] ?? a.plan) : null].filter(Boolean).join(" · ");
  return (
    <div className={current ? "claude-account current" : "claude-account"} role="listitem" data-testid="claude-account" data-id={a.id} data-current={current ? "1" : "0"}>
      <div className="claude-account-head">
        {renaming !== null ? (
          <form
            className="claude-account-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void act(`rename:${a.id}`, () => call(link, "PATCH /api/claude-accounts/:id", { id: a.id }, { label: renaming })).then(() => setRenaming(null));
            }}
          >
            <input className="field" value={renaming} onChange={(e) => setRenaming(e.target.value)} maxLength={60} aria-label="账号名字" autoFocus />
            <button type="submit" className="btn-ghost small">
              保存
            </button>
            <button type="button" className="btn-ghost small" onClick={() => setRenaming(null)}>
              取消
            </button>
          </form>
        ) : (
          <b className="claude-account-name" title={a.dir}>
            {a.label}
          </b>
        )}
        {current && <span className="claude-account-badge">✓ 正在使用</span>}
        {a.isDefault && <span className="claude-account-tag">本机默认</span>}
        <span className="spacer" />
        {!current && signedIn && !waiting && (
          <button
            type="button"
            className="btn-primary small"
            disabled={!!busy || !!switchBlocked}
            title={switchBlocked ?? `切换到「${a.label}」：之后 Claude 订阅的会话都用这个账号`}
            onClick={() => void act(`switch:${a.id}`, () => call(link, "PUT /api/claude-accounts/current", {}, { id: a.id }), `已切换到「${a.label}」`)}
            data-testid="claude-account-switch"
          >
            {busy === `switch:${a.id}` ? "切换中…" : "切换"}
          </button>
        )}
        {!waiting && (
          <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void act(`login:${a.id}`, () => call(link, "POST /api/claude-accounts/:id/login", { id: a.id }))} title="在浏览器里重新登录这个账号">
            {signedIn ? "重新登录" : "登录"}
          </button>
        )}
        {renaming === null && !waiting && (
          <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => setRenaming(a.label)}>
            改名
          </button>
        )}
        {!a.isDefault && !current && !waiting && (
          <button
            type="button"
            className="btn-ghost small danger"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm(`删除账号「${a.label}」？会删掉它在本机的登录和配置目录；对话记录在默认账号那里，不受影响。`)) void act(`remove:${a.id}`, () => call(link, "DELETE /api/claude-accounts/:id", { id: a.id }), `已删除「${a.label}」`);
            }}
            data-testid="claude-account-remove"
          >
            删除
          </button>
        )}
      </div>
      <span className="claude-account-sub">
        <span className={`credential-state${signedIn ? " saved" : ""}`}>{a.signedIn === null ? "无法检测登录" : signedIn ? "已登录" : "未登录"}</span>
        {sub && <span>{sub}</span>}
        <code className="login-dir" title={a.dir}>
          {a.dir}
        </code>
      </span>
      {a.login && (
        <div className="claude-account-login" data-testid="claude-account-login" data-state={a.login.state}>
          {waiting ? (
            <>
              <span className="settings-hint">◐ 正在等你在浏览器里登录…{a.login.url ? "" : "（正在打开浏览器）"}</span>
              {a.login.url && (
                <span className="settings-hint">
                  浏览器没打开？
                  <button type="button" className="link-btn" onClick={() => void (window.amo?.openExternal ? window.amo.openExternal(a.login!.url!) : window.open(a.login!.url!, "_blank"))}>
                    打开登录页
                  </button>
                  。登录后页面给了一串代码的话，粘贴到这里：
                </span>
              )}
              <form
                className="claude-account-code"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(`code:${a.id}`, () => call(link, "POST /api/claude-accounts/:id/login/code", { id: a.id }, { code })).then(() => setCode(""));
                }}
              >
                <input className="field" value={code} onChange={(e) => setCode(e.target.value)} placeholder="登录页给的代码（浏览器自动完成时不用填）" aria-label="登录代码" />
                <button type="submit" className="btn-ghost small" disabled={!code.trim()}>
                  提交
                </button>
                <button type="button" className="btn-ghost small" onClick={() => void act(`cancel:${a.id}`, () => call(link, "DELETE /api/claude-accounts/:id/login", { id: a.id }))}>
                  取消登录
                </button>
              </form>
            </>
          ) : (
            <span className="form-error" role="alert">
              ! {a.login.error ?? "登录没有完成"}
              <button type="button" className="link-btn" onClick={() => void act(`cancel:${a.id}`, () => call(link, "DELETE /api/claude-accounts/:id/login", { id: a.id }))}>
                知道了
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
