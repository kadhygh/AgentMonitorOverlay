import { useEffect, useState } from "react";
import type { MaintenanceCli, MaintenanceInfo } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 维护 (2026-10-20): whether this Studio runs from its git checkout, and a terminal in that repo running the
// person's own Claude Code, to work on Studio itself (2026-10-21: as they would open it themselves, no model of Studio's).
// 2026-10-28: or their own Codex: a row and a button for each.

const CLI_NAME: Record<MaintenanceCli, string> = { claude: "Claude Code", codex: "Codex" };
/** Shown in place of the path, and on the disabled button, when the CLI is not there. */
const MISSING: Record<MaintenanceCli, string> = {
  claude: "没有找到 Claude Code：PATH 上没有 claude，Studio 也没有自带的那份。先在终端里装好，能直接运行 claude 后重新打开这一页。",
  codex: "没有找到 Codex：PATH 上没有 codex。先在终端里装好（npm i -g @openai/codex），能直接运行 codex 后重新打开这一页。",
};

export function MaintenancePage({ link }: { link: HostLink }) {
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  useEffect(() => {
    call(link, "GET /api/maintenance").then(setInfo, fail);
  }, [link]);

  async function open(cli: MaintenanceCli) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await call(link, "POST /api/maintenance/terminal", {}, { cli });
      setMessage({ text: `已在 ${r.cwd} 打开 ${CLI_NAME[r.cli]}` });
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
            在工程目录开一个 PowerShell 窗口，运行你自己的 Claude Code 或 Codex，和你平时在终端里开的一样：用你自己的登录、记忆和设置（~/.claude、~/.codex），不带 Studio 的模型、端点和密钥。
          </span>
          {(["claude", "codex"] as const).map((cli) => {
            const exe = info ? info[cli] : null;
            return (
              <div className="maintenance-cli" key={cli}>
                <div className="settings-row">
                  <span className="settings-label">{CLI_NAME[cli]}</span>
                  <code className="settings-hint maintenance-path" data-testid={`maintenance-${cli}`} title={exe ?? undefined}>
                    {exe ?? "没有找到"}
                  </code>
                  <span className="spacer" />
                  <button
                    type="button"
                    className={cli === "claude" ? "btn-primary small" : "btn-ghost small"}
                    onClick={() => void open(cli)}
                    disabled={busy || !exe}
                    title={exe ? `在工程目录打开 ${CLI_NAME[cli]}` : MISSING[cli]}
                    data-testid={`maintenance-open-${cli}`}
                  >
                    打开 {CLI_NAME[cli]}
                  </button>
                </div>
                {!exe && <span className="settings-hint" data-testid={`maintenance-${cli}-missing`}>{MISSING[cli]}</span>}
              </div>
            );
          })}
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
