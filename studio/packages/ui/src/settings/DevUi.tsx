import { useEffect, useState } from "react";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 测试功能 → 开发界面目录 (2026-11-05, the user: 全景's view will take many rounds, and a release for each is too
// slow): the Host serves a UI build from a worktree instead of the installed one, so a change is a build there and a
// reload here. Kept by the Host in memory only: restarting Studio goes back to the installed UI (also the way out when
// the build in that folder does not even draw this window).

async function reloadAll() {
  location.reload();
}

export function DevUiSection({ link, dir }: { link: HostLink; dir: string | null }) {
  const [text, setText] = useState(dir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(dir ?? ""), [dir]);

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { devUiDir: next });
      await reloadAll();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-label="开发界面目录">
      <span className="settings-heading">开发界面目录</span>
      <span className="settings-hint">
        开发 Studio 界面时用：填一个构建好的界面目录（里面有 index.html，比如某个 worktree 的 studio\packages\ui\dist），Studio 的窗口就从那里载入界面，那边重新构建后按「重新载入」就能看到，不用发版、不用重启。只换界面，后台（Host）和会话不受影响。重启 Studio 后自动回到安装版的界面。
      </span>
      <div className="settings-row">
        <input
          className="field mono dev-ui-input"
          value={text}
          spellCheck={false}
          disabled={busy}
          placeholder="G:\PROJECT\…\studio\packages\ui\dist"
          aria-label="开发界面目录"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) void save(text.trim());
          }}
          data-testid="dev-ui-dir"
        />
        <button type="button" className="btn-primary small" disabled={busy || !text.trim() || text.trim() === dir} onClick={() => void save(text.trim())} data-testid="dev-ui-use">
          使用并重新载入
        </button>
        {dir && (
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void save(null)} data-testid="dev-ui-off">
            恢复安装版
          </button>
        )}
      </div>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}

/** The strip over the window while the UI comes from a 开发界面目录: where from, reload, back to the installed one. */
export function DevUiBar({ link, dir }: { link: HostLink; dir: string | null }) {
  const [busy, setBusy] = useState(false);
  if (!dir) return null;
  return (
    <div className="dev-ui-bar" role="status" data-testid="dev-ui-bar">
      <span className="dev-ui-bar-text">
        界面来自开发目录 <code title={dir}>{dir}</code>（重启 Studio 后自动恢复安装版）
      </span>
      <button type="button" className="btn-ghost small" onClick={() => void reloadAll()} data-testid="dev-ui-reload">
        重新载入
      </button>
      <button
        type="button"
        className="btn-ghost small"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void call(link, "PUT /api/settings", {}, { devUiDir: null }).then(reloadAll, () => setBusy(false));
        }}
        data-testid="dev-ui-bar-off"
      >
        恢复安装版
      </button>
    </div>
  );
}
