import { useEffect, useState } from "react";
import type { MaintenanceInfo } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 维护 (2026-10-20): whether this Studio runs from its git checkout, and a terminal in that repo running the
// person's own Claude Code, to work on Studio itself (2026-10-21: as they would open it themselves, no model of Studio's).

export function MaintenancePage({ link }: { link: HostLink }) {
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  useEffect(() => {
    call(link, "GET /api/maintenance").then(setInfo, fail);
  }, [link]);

  async function open() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await call(link, "POST /api/maintenance/terminal");
      setMessage({ text: `已在 ${r.cwd} 打开 Claude Code` });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const source = info?.source ?? null;
  return (
    <>
      <section className="settings-section" aria-label="运行方式">
        <span className="settings-heading">运行方式</span>
        {!info ? (
          <span className="settings-hint">读取中…</span>
        ) : source ? (
          <>
            <div className="settings-row" data-testid="maintenance-mode">
              <span className="settings-label">启动自</span>
              <span className="settings-tag">源码 · git 工程</span>
              <span className="settings-hint">用 start-studio.cmd 从工程源码构建运行，不是便携版。</span>
            </div>
            <div className="settings-row">
              <span className="settings-label">工程</span>
              <code className="settings-hint">{source.repoRoot}</code>
            </div>
            <div className="settings-row">
              <span className="settings-label">版本</span>
              <span className="settings-hint">
                {source.branch ?? "（分离的 HEAD）"}
                {source.commit ? ` · ${source.commit}` : ""}
                {source.changes ? ` · ${source.changes} 个文件有未提交的改动` : " · 没有未提交的改动"}
              </span>
            </div>
          </>
        ) : (
          <div className="settings-row" data-testid="maintenance-mode">
            <span className="settings-label">启动自</span>
            <span className="settings-tag">便携版</span>
            <span className="settings-hint">{info.studioRoot}</span>
          </div>
        )}
      </section>
      {source && (
        <section className="settings-section" aria-label="维护终端">
          <span className="settings-heading">维护终端</span>
          <span className="settings-hint">
            在工程目录开一个 PowerShell 窗口，运行你自己的 Claude Code，和你平时在终端里开的一样：用你的登录、~/.claude 里的记忆和设置，不带 Studio 的模型配置。
          </span>
          <div className="settings-row">
            <span className="settings-label">运行</span>
            <code className="settings-hint" data-testid="maintenance-claude">
              {info?.claude}
            </code>
          </div>
          <div className="settings-row end">
            <button type="button" className="btn-primary small" onClick={() => void open()} disabled={busy} data-testid="maintenance-open">
              打开维护终端
            </button>
          </div>
        </section>
      )}
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </span>
      )}
    </>
  );
}
