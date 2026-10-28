import { useEffect, useState } from "react";
import iconUrl from "./icon.svg";
import type { Health, ShellBuild } from "./shared.js";
import { shell } from "./env.js";
import { errorText } from "./Messages.js";
import { macLights, ownTitleBar, WindowControls } from "./Window.js";

// 更新桌面程序: the content updates itself, but the desktop program around it (the exe, its title bar, writing the
// usage file…) only changes when a new one is put in place. The service hands out its desktop program with a build
// stamp (/api/health `shell`); a program that can update itself downloads it, checks it, swaps its own files and
// restarts — one click, nothing to unpack. A program from before that (no updateShell) is shown how to switch once.

export type ShellUpdateKind = "auto" | "manual";

export interface ShellUpdate {
  kind: ShellUpdateKind;
  current: string | undefined;
  target: ShellBuild | null;
}

const EVERY = 30 * 60_000;

/** Whether this desktop program is behind the service's. `health` reads /api/health (again every half hour). */
export function useShellUpdate(health: () => Promise<Health>): ShellUpdate | null {
  const [state, setState] = useState<ShellUpdate | null>(null);
  useEffect(() => {
    if (!shell) return;
    let gone = false;
    const check = async () => {
      try {
        const [h, info] = await Promise.all([health(), shell!.info()]);
        if (gone) return;
        // Installed by AMO 平台 (2026-10-28): the platform updates this program; the service's zip is for the unpacked
        // ones, and swapping files here would change the Electron files the platform shares between its tools.
        if (info.updatedBy === "platform") return setState(null);
        const target = h.shell ?? null;
        if (!shell!.updateShell) setState({ kind: "manual", current: info.shellBuild, target });
        else setState(target && target.build !== info.shellBuild ? { kind: "auto", current: info.shellBuild, target } : null);
      } catch {
        // the service away: asked again next time
      }
    };
    void check();
    const timer = setInterval(() => void check(), EVERY);
    return () => ((gone = true), clearInterval(timer));
  }, [health]);
  return state;
}

type Step = { step: "download" | "check" | "unpack" | "replace" | "restart"; done: number; total: number };

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The page of its own (over everything) where the desktop program is updated. */
export function ShellUpdatePage({ update, server, onClose }: { update: ShellUpdate; server: string; onClose: () => void }) {
  const [progress, setProgress] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The program could not swap itself this time: switching by hand is the way.
  const [manual, setManual] = useState(false);
  const running = !!progress && !error;
  useEffect(() => {
    shell?.onShellProgress?.((p) => setProgress(p));
  }, []);
  const start = async () => {
    setError(null);
    setProgress({ step: "download", done: 0, total: update.target?.size ?? 0 });
    try {
      await shell!.updateShell!();
    } catch (err) {
      const text = errorText(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      const at = text.indexOf("MANUAL:");
      setManual(at >= 0);
      setError(at >= 0 ? text.slice(at + "MANUAL:".length) : text);
    }
  };
  // Downloading is most of the wait, replacing the files the rest.
  const pct = !progress
    ? 0
    : progress.step === "download"
      ? Math.round((progress.total ? progress.done / progress.total : 0) * 70)
      : progress.step === "replace"
        ? 75 + Math.round((progress.total ? progress.done / progress.total : 0) * 24)
        : { check: 72, unpack: 74, restart: 100 }[progress.step];
  const stepText = !progress
    ? null
    : {
        download: `正在下载 ${MB(progress.done)} / ${MB(progress.total)}`,
        check: "正在校验下载的文件",
        unpack: "正在解压",
        replace: `正在换文件 ${progress.done} / ${progress.total}`,
        restart: "马上关闭并换上新版，几秒后会自己重新打开",
      }[progress.step];
  return (
    <div className="login-page shell-page" role="dialog" aria-label="更新桌面程序">
      {ownTitleBar && (
        <div className={`login-titlebar ${macLights ? "mac" : ""}`}>
          <span className="grow" />
          <WindowControls />
        </div>
      )}
      <div className="login-card shell-card">
        <div className="brand">
          <img className="brand-mark" src={iconUrl} alt="" />
          <div>
            <h1>更新桌面程序</h1>
            <p className="muted">界面平时自己更新；窗口、标题栏这些外壳要换新的桌面程序</p>
          </div>
        </div>

        {update.kind === "auto" ? (
          <>
            <div className="shell-versions">
              <div>
                <span className="tiny muted">现在</span>
                <b>{update.current ?? "旧版"}</b>
              </div>
              <span className="shell-arrow">→</span>
              <div>
                <span className="tiny muted">新版</span>
                <b>{update.target?.build}</b>
              </div>
            </div>
            <ul className="shell-notes">
              <li>点下面的按钮，会自动下载（约 {MB(update.target?.size ?? 0)}）、换掉这个程序的文件，再重新打开。</li>
              <li>账号、密码、聊天记录都在原来的地方，不用重新登录。</li>
              <li>还没发出去的草稿会丢，先发掉或复制一下。</li>
            </ul>
            {progress && (
              <div className="shell-progress" aria-live="polite">
                <div className="bar">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="tiny">{error ? "没有更新成功" : stepText}</span>
              </div>
            )}
            {error && (
              <div className="notice error">
                ! {error}
                {manual && <div className="tiny">这一次请手动换：打开下载页下载新版，解压后直接打开新的 AMO Relay.exe，它会接替现在这个。</div>}
              </div>
            )}
            <div className="shell-acts">
              <button type="button" onClick={onClose} disabled={running}>
                以后再说
              </button>
              {manual ? (
                <button type="button" className="primary" onClick={() => shell?.openExternal(server)}>
                  打开下载页
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => void start()} disabled={running}>
                  {error ? "重试" : running ? "正在更新…" : "更新并重启"}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="lead-p">你在用的桌面程序还不会自己更新，这一次要手动换一下；换上之后，以后在这里点一下就能更新。</p>
            <ol className="steps">
              <li>点「打开下载页」，下载新的客户端，解压到任意文件夹。</li>
              <li>直接打开新解压的 AMO Relay.exe。要是只弹出了现在这个窗口，就在右下角托盘图标上右键 →「退出」，再打开一次。</li>
              <li>账号、密码和记录都在原来的地方，不用重新登录。</li>
            </ol>
            <div className="shell-acts">
              <button type="button" onClick={onClose}>
                以后再说
              </button>
              <button type="button" className="primary" onClick={() => shell?.openExternal(server)}>
                打开下载页
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
