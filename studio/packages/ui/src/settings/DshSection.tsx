import { useEffect, useState } from "react";
import type { DshStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { pickFolder } from "../lib/profiles.js";

// 设置 → 模型 → DSH · DeepSeek (stage 17): what its sessions run on. The DeepSeek Harness desktop app when it is
// installed (2026-10-26: it updates itself), or a source clone the person builds and pulls. 「检查」 tells whether Studio
// works with it (it starts DSH and opens a session, no model call). plans/done/stage-17-dsh.md lists what Studio relies on.


/** Said after the desktop app's folder: how it was found. */
const DESKTOP_FROM: Record<NonNullable<DshStatus["desktop"]>["from"], string> = { env: "，AMO_STUDIO_DSH_DESKTOP 指定的", chosen: "，你选的文件夹", default: "", registry: "，按安装记录找到的" };

/** `credentialId`: the built-in DeepSeek's API key in the Credential Manager ("deepseek-v4"). */
export function DshSection({ link, credentialId }: { link: HostLink; credentialId: string | undefined }) {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [text, setText] = useState("");
  const [desktopText, setDesktopText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    call(link, "GET /api/dsh")
      .then((s) => {
        setStatus(s);
        setText(s.path ?? "");
        setDesktopText(s.desktopChosen ?? "");
      })
      .catch(() => undefined);
  }, [link]);

  async function reload() {
    try {
      setStatus(await call(link, "GET /api/dsh"));
    } catch {
      // the Host is away: the page shows what it last had
    }
  }

  /** Saves the API key ("" removes it); the key never comes back from the Host. */
  async function saveKey(secret: string) {
    setBusy("save");
    setMessage(null);
    try {
      if (!credentialId) throw new Error("这个渠道没有 Key 可以设置");
      if (secret) await call(link, "PUT /api/credentials/:id", { id: credentialId }, { secret });
      else await call(link, "DELETE /api/credentials/:id", { id: credentialId });
      setKeyText("");
      await reload();
      setMessage({ text: secret ? "Key 已保存。之后新开或恢复的 DeepSeek 会话用它" : "已删除 Key" });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function put(body: { path?: string | null; source?: "auto" | "clone"; desktopPath?: string | null; auth?: "account" | "key" }, done: (s: DshStatus) => string | null) {
    setBusy("save");
    setMessage(null);
    try {
      const s = await call(link, "PUT /api/dsh", {}, body);
      setStatus(s);
      setText(s.path ?? "");
      setDesktopText(s.desktopChosen ?? "");
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

  const saveDesktop = (desktopPath: string | null) => put({ desktopPath }, () => (desktopPath ? "已保存。点「检查」确认能用" : "改回自动找了"));

  async function browseDesktop() {
    const dir = await pickFolder();
    if (dir) {
      setDesktopText(dir);
      void saveDesktop(dir);
    }
  }

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
        用 DeepSeek Harness 自己的框架跑 DeepSeek（上下文管理、工具都是 DSH 原生的）。运行中发的消息会排队，这一轮做完自动接着发（和 DSH 默认的「排队」一样）；图片看型号，DeepSeek-V4.1-Flash 能看图；还不能分支、不能在终端打开。
      </span>
      {/* 2026-11-03, the user: a computer that never had old AMO had no way to set the key, and the desktop app works
          once signed in without one. So: the desktop app's account, or a key typed in here. */}
      <div className="settings-row" role="group" aria-label="DeepSeek 登录方式">
        <span className="settings-label">登录方式</span>
        <button type="button" className="chip small" aria-pressed={status?.auth === "account"} disabled={!status || !!busy} onClick={() => status?.auth !== "account" && void put({ auth: "account" }, () => null)} data-testid="dsh-auth-account">
          DSH 桌面版的账号
        </button>
        <button type="button" className="chip small" aria-pressed={status?.auth === "key"} disabled={!status || !!busy} onClick={() => status?.auth !== "key" && void put({ auth: "key" }, () => null)} data-testid="dsh-auth-key">
          API Key
        </button>
      </div>
      {status?.auth === "account" &&
        (status.account.signedIn ? (
          <span className="settings-hint" data-testid="dsh-account">
            ✓ 桌面版已登录 DeepSeek 账号。DeepSeek 会话用这个账号，不用 Key，用量和余额也算在它上面；在桌面版里退出或换账号，这里跟着变。读的是 <code>{status.account.file}</code>
          </span>
        ) : (
          <div className="settings-row" data-testid="dsh-account">
            <span className="form-error">
              ! 桌面版还没有登录 DeepSeek 账号：打开 DeepSeek Harness 桌面版登录一次，再回来点「重新检测」。（读的是 <code>{status.account.file}</code>）
            </span>
            <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void reload()} data-testid="dsh-account-recheck">
              重新检测
            </button>
          </div>
        ))}
      {status?.auth === "key" && (
        <>
          <div className="settings-row" data-testid="dsh-key">
            <span className={`credential-state${status.keySaved ? " saved" : ""}`}>{status.keySaved ? "Key 已保存" : "还没有 Key"}</span>
            <input
              className="field"
              type="password"
              autoComplete="off"
              aria-label="DeepSeek API Key"
              placeholder={status.keySaved ? "填新的 Key 替换现在的" : "sk-…（DeepSeek 开放平台的 API Key）"}
              value={keyText}
              disabled={!!busy}
              onChange={(e) => setKeyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && keyText.trim()) void saveKey(keyText.trim());
              }}
              data-testid="dsh-key-input"
            />
            <button type="button" className="btn-primary small" disabled={!!busy || !keyText.trim()} onClick={() => void saveKey(keyText.trim())} data-testid="dsh-key-save">
              保存
            </button>
            {status.keySaved && (
              <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void saveKey("")} data-testid="dsh-key-clear">
                删除
              </button>
            )}
          </div>
          <span className="settings-hint">Key 存在 Windows 凭据管理器里，只在启动 DSH 时交给它。</span>
        </>
      )}
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
            ? `✓ 用 DeepSeek Harness 桌面版${status.desktop.version ? ` ${status.desktop.version}` : ""}（${status.desktop.path}${DESKTOP_FROM[status.desktop.from]}）。桌面版会自己更新，之后新开或恢复的 DSH 会话用新版本。`
            : `没找到 DeepSeek Harness 桌面版（在 ${status.desktopDir ?? "%LOCALAPPDATA%\\Programs\\DeepSeek Harness"} 和安装记录里找过）。装在别的文件夹的话，在下面选它的文件夹；装好桌面版后回到这里就会用上；也可以改用下面的源码克隆${status.path ? "，现在先用它" : ""}。`}
        </span>
      )}
      {/* 2026-11-02, the user: people install the desktop app in another folder. Chosen here when it is not found, or to
          change the one chosen; a chosen folder that no longer has it says so. */}
      {status && source === "auto" && status.desktop?.from !== "env" && (!status.desktop || status.desktopChosen) && (
        <>
          {status.desktopChosen && status.desktop?.from !== "chosen" && (
            <span className="form-error" data-testid="dsh-desktop-chosen-gone">
              选的文件夹 {status.desktopChosen} 里没有桌面版了{status.desktop ? "，现在用的是上面找到的" : ""}。
            </span>
          )}
          <div className="settings-row">
            <input
              className="field"
              aria-label="DeepSeek Harness 桌面版的文件夹"
              placeholder="桌面版装在哪个文件夹，例如 D:\Apps\DeepSeek Harness"
              value={desktopText}
              disabled={!!busy}
              onChange={(e) => setDesktopText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && desktopText.trim()) void saveDesktop(desktopText.trim());
              }}
              data-testid="dsh-desktop-path"
            />
            {window.amo?.pickDirectory && (
              <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void browseDesktop()}>
                选择文件夹…
              </button>
            )}
            <button type="button" className="btn-primary small" disabled={!!busy || !desktopText.trim() || desktopText.trim() === status.desktopChosen} onClick={() => void saveDesktop(desktopText.trim())} data-testid="dsh-desktop-save">
              保存
            </button>
            {status.desktopChosen && (
              <button type="button" className="btn-ghost small" disabled={!!busy} onClick={() => void saveDesktop(null)} data-testid="dsh-desktop-clear">
                改回自动找
              </button>
            )}
          </div>
        </>
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
