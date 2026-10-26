import { useEffect, useState } from "react";
import type { DshStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { pickFolder } from "../lib/profiles.js";

// 设置 → 模型 → DSH · DeepSeek (stage 17): what its sessions run on. The DeepSeek Harness desktop app when it is
// installed (2026-10-26: it updates itself), or a source clone the person builds and pulls. 「检查」 tells whether Studio
// works with it (it starts DSH and opens a session, no model call). plans/stage-17-dsh.md lists what Studio relies on.

export function DshSection({ link }: { link: HostLink }) {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    call(link, "GET /api/dsh")
      .then((s) => {
        setStatus(s);
        setText(s.path ?? "");
      })
      .catch(() => undefined);
  }, [link]);

  async function put(body: { path?: string | null; source?: "auto" | "clone" }, done: (s: DshStatus) => string | null) {
    setBusy("save");
    setMessage(null);
    try {
      const s = await call(link, "PUT /api/dsh", {}, body);
      setStatus(s);
      setText(s.path ?? "");
      const note = done(s);
      if (note) setMessage({ text: note });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  const save = (path: string | null) =>
    put({ path }, (s) => (path ? (s.built ? "已保存。点「检查」确认能用" : "已保存，但还没有构建") : "已清除源码位置"));

  async function check() {
    setBusy("check");
    setMessage(null);
    try {
      setStatus(await call(link, "POST /api/dsh/check"));
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function browse() {
    const dir = await pickFolder();
    if (dir) {
      setText(dir);
      void save(dir);
    }
  }

  const source = status?.source ?? "auto";
  // The clone is what runs when it is chosen, or when no desktop app is installed.
  const usesClone = !!status && (source === "clone" || !status.desktop);
  const facts = status?.path
    ? [status.version ? `版本 ${status.version}` : null, status.commit ? `提交 ${status.commit}${status.commitDate ? `（${status.commitDate}）` : ""}` : null, status.built ? "已构建" : "未构建"].filter(Boolean).join(" · ")
    : null;
  const nodeNote = usesClone && status?.path && !status.node ? "找不到系统的 Node：DSH 源码克隆要用它运行（装 Node 24 LTS）" : null;
  const checked = status?.check && status.active && (status.check.kind ?? "clone") === status.active.kind ? status.check : null;

  return (
    <div className="dsh-section" data-testid="dsh-section">
      <span className="settings-hint">
        用 DeepSeek Harness 自己的框架跑 DeepSeek（上下文管理、工具都是 DSH 原生的）；Key 用上面的 DeepSeek 凭据。运行中发的消息会排队，这一轮做完自动接着发（和 DSH 默认的「排队」一样）；还不能发图片、不能分支、不能在终端打开。
      </span>
      <div className="settings-row" role="group" aria-label="DSH 来源">
        <span className="settings-label">来源</span>
        <button type="button" className="chip small" aria-pressed={source === "auto"} disabled={!!busy} onClick={() => source !== "auto" && void put({ source: "auto" }, () => null)} data-testid="dsh-source-auto">
          桌面版（自动找）
        </button>
        <button type="button" className="chip small" aria-pressed={source === "clone"} disabled={!!busy} onClick={() => source !== "clone" && void put({ source: "clone" }, () => null)} data-testid="dsh-source-clone">
          源码克隆
        </button>
      </div>
      {status && source === "auto" && (
        <span className={status.desktop ? "settings-hint" : "form-error"} data-testid="dsh-desktop">
          {status.desktop
            ? `✓ 用 DeepSeek Harness 桌面版${status.desktop.version ? ` ${status.desktop.version}` : ""}（${status.desktop.path}）。桌面版会自己更新，之后新开或恢复的 DSH 会话用新版本。`
            : `没找到 DeepSeek Harness 桌面版（在 ${status.desktopDir ?? "%LOCALAPPDATA%\\Programs\\DeepSeek Harness"} 找过）。装好桌面版后回到这里就会用上；也可以改用下面的源码克隆${status.path ? "，现在先用它" : ""}。`}
        </span>
      )}
      {usesClone && (
        <>
          <div className="settings-row">
            <input
              className="field"
              aria-label="DSH 源码位置"
              placeholder="例如 G:\PROJECT\deepseek-harness"
              value={text}
              disabled={!!busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) void save(text.trim());
              }}
              data-testid="dsh-path"
            />
            {window.amo?.pickDirectory && (
              <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void browse()}>
                选择文件夹…
              </button>
            )}
            <button type="button" className="btn-primary small" disabled={!!busy || !text.trim() || text.trim() === status?.path} onClick={() => void save(text.trim())} data-testid="dsh-save">
              保存
            </button>
            {status?.path && (
              <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void save(null)} data-testid="dsh-clear">
                清除
              </button>
            )}
          </div>
          {facts && (
            <span className="settings-label" data-testid="dsh-facts">
              {facts}
            </span>
          )}
        </>
      )}
      {status?.active && (
        <div className="settings-row">
          <span className="settings-label">现在用的是{status.active.kind === "desktop" ? "桌面版" : "源码克隆"}</span>
          <span className="spacer" />
          <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void check()} data-testid="dsh-check">
            {busy === "check" ? "检查中…" : "检查"}
          </button>
        </div>
      )}
      {checked && (
        <span className={checked.ok ? "settings-hint" : "form-error"} data-testid="dsh-check-result">
          {checked.ok ? "✓ " : "✗ "}
          {checked.message}
          {checked.kind !== "desktop" && checked.commit && checked.commit !== status?.commit ? `（检查的是提交 ${checked.commit}，之后又拉过，再点一次检查）` : ""}
        </span>
      )}
      {status && !status.active && status.unavailable && (source === "clone" || status.path) && (
        <span className="form-error" data-testid="dsh-unavailable">
          {status.unavailable}
        </span>
      )}
      {nodeNote && <span className="form-error">{nodeNote}</span>}
      {usesClone && status?.path && (
        <span className="settings-hint">
          更新：在源码目录运行 <code>git pull</code>、<code>pnpm install</code>、<code>pnpm run build:artifacts</code>，再点「检查」。之后新开或恢复的 DSH 会话用新版本。
        </span>
      )}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </span>
      )}
    </div>
  );
}
