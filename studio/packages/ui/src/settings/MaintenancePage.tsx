import { useEffect, useState } from "react";
import type { MaintenanceInfo } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 维护 (2026-10-20): whether this Studio runs from its git checkout, and a terminal in that repo with a model's
// own CLI (Claude Code or Codex, signed in as 设置 → 模型 has it), to work on Studio itself.

const PROFILE_KEY = "amo.maintenanceProfile";

function savedProfile(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

const CLI_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

export function MaintenancePage({ link }: { link: HostLink }) {
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);
  const [profileId, setProfileId] = useState<string | null>(savedProfile);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  useEffect(() => {
    call(link, "GET /api/maintenance").then(setInfo, fail);
  }, [link]);

  const profiles = info?.profiles ?? [];
  const chosen = profiles.find((p) => p.profileId === profileId) ?? profiles[0] ?? null;

  function choose(id: string) {
    setProfileId(id);
    try {
      localStorage.setItem(PROFILE_KEY, id);
    } catch {
      // Remembering the choice is a convenience only.
    }
  }

  async function open() {
    if (!chosen) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await call(link, "POST /api/maintenance/terminal", {}, { profileId: chosen.profileId });
      setMessage({ text: `已在 ${r.cwd} 打开 ${CLI_LABEL[chosen.runtime] ?? chosen.runtime}（${chosen.label}）` });
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
            在工程目录开一个 PowerShell 窗口，用选中的模型直接运行它的命令行（Claude Code 或 Codex），登录和密钥按 设置 → 模型 里配好的来。Claude Code
            用你自己的 ~/.claude，记忆和设置和平时在终端里一样。
          </span>
          {profiles.length ? (
            <div role="radiogroup" aria-label="维护用的模型" className="chips">
              {profiles.map((p) => (
                <button
                  key={p.profileId}
                  type="button"
                  role="radio"
                  className="chip"
                  aria-checked={chosen?.profileId === p.profileId}
                  aria-pressed={chosen?.profileId === p.profileId}
                  onClick={() => choose(p.profileId)}
                >
                  {p.label} · {CLI_LABEL[p.runtime] ?? p.runtime}
                </button>
              ))}
            </div>
          ) : (
            <span className="settings-hint">没有可用的 Claude 或 Codex 模型：先到 设置 → 模型 配一个。</span>
          )}
          <div className="settings-row end">
            <button type="button" className="btn-primary small" onClick={() => void open()} disabled={busy || !chosen} data-testid="maintenance-open">
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
