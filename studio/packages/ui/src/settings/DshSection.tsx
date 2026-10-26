import { useEffect, useState } from "react";
import type { DshStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { pickFolder } from "../lib/profiles.js";

// 设置 → 模型 → DSH · DeepSeek (stage 17): the DeepSeek Harness source clone its sessions run on. The person pulls the
// clone now and then; 「检查」 then tells whether Studio still works with it (it starts DSH and opens a session, no
// model call). plans/stage-17-dsh.md lists what Studio relies on in DSH.

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

  async function save(path: string | null) {
    setBusy("save");
    setMessage(null);
    try {
      const s = await call(link, "PUT /api/dsh", {}, { path });
      setStatus(s);
      setText(s.path ?? "");
      setMessage({ text: path ? (s.built ? "已保存。点「检查」确认能用" : "已保存，但还没有构建") : "已清除：DSH · DeepSeek 不再出现在模型选择里" });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
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

  const facts = status?.path
    ? [status.version ? `版本 ${status.version}` : null, status.commit ? `提交 ${status.commit}${status.commitDate ? `（${status.commitDate}）` : ""}` : null, status.built ? "已构建" : "未构建"].filter(Boolean).join(" · ")
    : null;
  const nodeNote = status && !status.node ? "找不到系统的 Node：DSH 要用它运行（装 Node 24 LTS）" : null;

  return (
    <div className="dsh-section" data-testid="dsh-section">
      <span className="settings-hint">
        用 DeepSeek Harness 自己的框架跑 DeepSeek（上下文管理、工具都是 DSH 原生的）。填你本机的 DSH 源码克隆；Key 用上面的 DeepSeek 凭据。运行中发的消息会排队，这一轮做完自动接着发（和 DSH 默认的「排队」一样）；还不能发图片、不能分支、不能在终端打开。
      </span>
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
        <div className="settings-row">
          <span className="settings-label" data-testid="dsh-facts">
            {facts}
          </span>
          <span className="spacer" />
          <button type="button" className="btn-ghost small" disabled={!!busy || !status?.built} onClick={() => void check()} data-testid="dsh-check">
            {busy === "check" ? "检查中…" : "检查"}
          </button>
        </div>
      )}
      {status?.check && status.path && (
        <span className={status.check.ok ? "settings-hint" : "form-error"} data-testid="dsh-check-result">
          {status.check.ok ? "✓ " : "✗ "}
          {status.check.message}
          {status.check.commit && status.check.commit !== status.commit ? `（检查的是提交 ${status.check.commit}，之后又拉过，再点一次检查）` : ""}
        </span>
      )}
      {nodeNote && <span className="form-error">{nodeNote}</span>}
      {status?.path && (
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
