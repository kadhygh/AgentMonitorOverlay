import { useEffect, useState } from "react";
import { call, type EnvironmentView, type EnvItemView, type EnvUpdateResult } from "./bridge.js";
import "./environment.css";

// AMO 平台's 环境 page (the user, 2026-10-28; packages/platform/src/environment.ts): whether Claude Code, the DeepSeek
// Harness desktop app, Codex and git are installed, what needs them, and for what is missing a link to its official
// page. Claude Code and Codex also show npm's newest version, with 更新 when there is a newer one (2026-10-29, the user:
// like cc-switch, only here and only when clicked — nothing suggests it elsewhere). The tools still check for themselves.

/** Newer than what is installed: npm's latest beats the version here. */
export function newer(latest: string | null, installed: string | null): boolean {
  if (!latest || !installed) return false;
  const a = latest.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const b = installed.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

function statusText(it: EnvItemView): string {
  const version = it.version ? ` · ${it.version}` : "";
  const latest = it.latest && it.version ? (newer(it.latest, it.version) ? ` · 最新 ${it.latest}` : " · 已是最新") : "";
  if (it.state === "ok") return `✓ 已安装${version}${latest}`;
  if (it.state === "attention") return `! 需要注意${version}${latest}`;
  return it.id === "dsh" ? "○ 没装 · 推荐装桌面版" : "○ 没装";
}

const TONE: Record<EnvItemView["state"], string> = { ok: "ok", attention: "warn", missing: "idle" };

export function EnvironmentPage() {
  const [env, setEnv] = useState<EnvironmentView | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = (fresh: boolean) => {
    setChecking(true);
    setError(null);
    void call("environment", fresh)
      .then(setEnv, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setChecking(false));
  };
  useEffect(() => check(false), []);

  return (
    <div className="pf-page">
      <div>
        <h1 className="pf-h1">环境</h1>
        <p className="pf-hint">AMO 的工具要用到的程序。没装的给官方下载页；Claude Code 和 Codex 会显示最新版本，有新版时可以点「更新」（只在你点的时候才更新）。不装平台，各工具也会自己检测和提示。</p>
      </div>
      <div className="pf-row">
        <button type="button" className="btn-ghost pf-small" disabled={checking} onClick={() => check(true)}>
          {checking ? "正在检测…" : "重新检测"}
        </button>
        <span className="pf-hint" role="status" data-testid="env-checked">
          {checking ? "◐ 正在检测，每一项最多等几十秒" : env ? `检测于 ${new Date(env.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          ! 检测没成功：{error}
        </p>
      )}
      {env?.items.map((it) => <EnvItem key={it.id} item={it} onView={setEnv} />)}
      {env && <p className="pf-hint">刚装好的程序还显示没装：先点「重新检测」；还是没有的话，退出平台（托盘右键 → 退出平台）再打开。平台和从这里打开的工具，用的是平台启动时的 PATH。</p>}
    </div>
  );
}

function EnvItem({ item: it, onView }: { item: EnvItemView; onView: (v: EnvironmentView) => void }) {
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const canUpdate = !!it.updater && newer(it.latest, it.version);
  const update = () => {
    setUpdating(true);
    setResult(null);
    void (call("updateEnvironment", it.id) as Promise<EnvUpdateResult>)
      .then(
        (r) => {
          setResult({ ok: r.ok, message: r.message });
          if (r.view) onView(r.view);
        },
        (err: unknown) => setResult({ ok: false, message: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setUpdating(false));
  };
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const offerDownload = it.state !== "ok" && !!it.download;
  // Not there, or there but not answering: install it (again). An outdated one says `claude update` in its note.
  const offerCommand = !!it.installCommand && it.state !== "ok" && !it.version;

  return (
    <section className="pf-tool" aria-label={it.name} data-testid={`env-${it.id}`}>
      <div className="pf-tool-head">
        <div className="pf-tool-text">
          <div className="pf-tool-name">{it.name}</div>
          <div className={`pf-status ${TONE[it.state]}`} data-testid={`env-${it.id}-status`}>
            {statusText(it)}
          </div>
          <div className="pf-hint">用在：{it.uses}</div>
        </div>
        {(canUpdate || updating) && (
          <div className="pf-actions">
            <button type="button" className="btn-primary" disabled={updating} title={`运行 ${it.updater}`} onClick={update} data-testid={`env-${it.id}-update`}>
              {updating ? "正在更新…" : `更新到 ${it.latest}`}
            </button>
          </div>
        )}
        {offerDownload && (
          <div className="pf-actions">
            <button type="button" className="btn-ghost" title={it.download!} onClick={() => void call("openDownload", it.id)}>
              去下载
            </button>
          </div>
        )}
      </div>
      {it.path && (
        <code className="pf-path" title={it.path}>
          {it.path}
        </code>
      )}
      {result && (
        <p className={`pf-env-note${result.ok ? "" : " warn"}`} role="status" data-testid={`env-${it.id}-result`} style={{ whiteSpace: "pre-wrap" }}>
          {result.ok ? "✓ " : "! "}
          {result.message}
        </p>
      )}
      {it.note && (
        <p className={`pf-env-note${it.state === "attention" ? " warn" : ""}`} data-testid={`env-${it.id}-note`}>
          {it.note}
        </p>
      )}
      {offerCommand && (
        <div className="pf-env-command">
          <span className="pf-hint">也可以在 PowerShell 里运行：</span>
          <code className="pf-path">{it.installCommand}</code>
          <button type="button" className="pf-link" onClick={() => void call("copyInstallCommand").then(() => setCopied(true))}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      )}
    </section>
  );
}
