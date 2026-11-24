import { useState } from "react";
import type { AgyStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

// 设置 → 模型 → Antigravity · Gemini (2026-11-24, plans/agy.md): which agy Gemini sessions run on, its Google sign-in
// (agy's own, in a browser window), 「检查」, and the models besides Gemini agy offers — off until turned on here (the
// user: 默认不可选，但是可以在设置里将这些选出来).

const SIGN_IN: Record<string, string> = {
  "oauth-personal": "Google 账号",
  "oauth-business": "Gemini Enterprise",
  "gemini-api-key": "Gemini API Key",
  "agent-platform": "Gemini Enterprise Agent Platform",
};

export function AgySection({ link }: { link: HostLink }) {
  // profiles.updated follows a sign-in, a 「检查」 and a change of the models (the Host publishes it after each).
  const [status, setStatus, reload] = useLiveResource<AgyStatus | null>({ load: () => call(link, "GET /api/agy"), initial: null, reloadOn: (e) => e.type === "profiles.updated" }, [link]);
  const [busy, setBusy] = useState<"check" | "login" | "models" | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  async function run(kind: "check" | "login" | "models", fn: () => Promise<AgyStatus>) {
    setBusy(kind);
    setMessage(null);
    try {
      const s = await fn();
      setStatus(s);
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      reload();
    } finally {
      setBusy(null);
    }
  }

  const toggleModel = (id: string, on: boolean) => {
    const now = status?.extraModels ?? [];
    const extraModels = on ? [...now, id] : now.filter((x) => x !== id);
    void run("models", () => call(link, "PUT /api/agy", {}, { extraModels }));
  };

  const loggingIn = status?.login?.state === "running";
  const others = (status?.offered ?? []).filter((m) => !/^gemini/i.test(m.id));

  return (
    <div className="dsh-section" data-testid="agy-section">
      <span className="settings-hint">
        用 Google 的 Antigravity CLI（agy）跑 Gemini，登录的是你自己的 Google 账号，用量算在这个账号上。运行中发的消息会排队，这一轮做完接着发；不能分支、不能在终端打开。权限：只读 = agy 的计划模式，可写 = 自动接受编辑（命令照样问你），完全访问 = 不再询问。
      </span>
      <div className="settings-row" data-testid="agy-exe">
        <span className="settings-label">agy</span>
        {status?.exe && !status.unavailable ? (
          <span className="settings-hint">
            ✓ {status.exe.version ? `${status.exe.version} · ` : ""}
            <code>{status.exe.path}</code>
          </span>
        ) : status ? (
          <span className="form-error">! {status.unavailable}</span>
        ) : (
          <span className="settings-hint">正在读取…</span>
        )}
      </div>
      {status && !status.unavailable && (
        <div className="settings-row" data-testid="agy-sign-in">
          <span className="settings-label">登录</span>
          {/* agy keeps its own sign-in; one made in agy's terminal leaves no trace Studio reads, so a 「检查」 that opened a session counts too. */}
          <span className={status.signIn || status.check?.ok ? "settings-hint" : "form-error"}>
            {status.signIn
              ? `✓ 上次用 ${SIGN_IN[status.signIn.method] ?? status.signIn.method} 登录过（过期的话「检查」会说）`
              : status.check?.ok
                ? "✓ 已登录（上次「检查」能开会话）"
                : status.check?.needsLogin
                  ? "! agy 还没有登录"
                  : "○ 不知道登录了没有：点「检查」看看，没登录就点「登录 Google 账号」"}
          </span>
          <span className="spacer" />
          <button type="button" className="btn-ghost small" disabled={!!busy || loggingIn} onClick={() => void run("login", () => call(link, "POST /api/agy/login"))} data-testid="agy-login">
            {loggingIn ? "等你在浏览器里登录…" : "登录 Google 账号"}
          </button>
          <button type="button" className="btn-ghost small" disabled={!!busy || loggingIn} onClick={() => void run("check", () => call(link, "POST /api/agy/check"))} data-testid="agy-check">
            {busy === "check" ? "检查中…" : "检查"}
          </button>
        </div>
      )}
      {status?.login && (
        <span className={status.login.state === "failed" ? "form-error" : "settings-hint"} data-testid="agy-login-state">
          {status.login.state === "done" ? "✓ " : status.login.state === "failed" ? "✗ " : "◐ "}
          {status.login.message}
        </span>
      )}
      {status?.check && (
        <span className={status.check.ok ? "settings-hint" : "form-error"} data-testid="agy-check-result">
          {status.check.ok ? "✓ " : "✗ "}
          {status.check.message}
          {status.check.version && status.exe?.version && status.check.version !== status.exe.version ? `（检查的是 ${status.check.version}，agy 之后更新过，再点一次检查）` : ""}
        </span>
      )}
      {others.length > 0 && (
        <>
          <span className="settings-label">Gemini 以外的型号</span>
          <span className="settings-hint">agy 也能用这些型号（经 Google 转），默认不出现在模型选择里，勾上的才出现。</span>
          {others.map((m) => {
            const on = !!status?.extraModels.includes(m.id);
            return (
              <label key={m.id} className="settings-row" data-testid={`agy-model-${m.id}`}>
                <input type="checkbox" checked={on} disabled={!!busy} onChange={(e) => toggleModel(m.id, e.target.checked)} />
                <span>{m.label}</span>
                <code className="settings-hint">{m.id}</code>
              </label>
            );
          })}
        </>
      )}
      {status && !status.unavailable && !status.offered.length && <span className="settings-hint">agy 有哪些型号要「检查」一次（或开一个会话）才知道。</span>}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </span>
      )}
    </div>
  );
}
