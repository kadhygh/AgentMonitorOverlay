import { useEffect, useState } from "react";
import type { CrashDumpsInfo } from "../host/client.js";

// 设置 → 维护 → 崩溃转储 (2026-11-10, the user's call): Crashpad minidumps of Studio's own processes, kept on this
// machine (never uploaded), the newest 5. On by default on the AMO platform's test channel, off on the stable one; the
// switch here overrides that for this Studio, from its next start (Crashpad cannot be stopped in a running process).
// Electron only: in a browser there is no window.amo.crashDumps and the section is not shown.

const DEFAULT_TEXT: Record<CrashDumpsInfo["next"]["why"], string> = {
  "test-channel": "按默认：AMO 平台是测试通道，默认开着。",
  "stable-channel": "按默认：AMO 平台是正式通道，默认关着。",
  "no-platform": "按默认：这台电脑没有设置过 AMO 平台，按正式通道算，默认关着。",
  setting: "",
  env: "这次由环境变量 AMO_CRASH_DUMPS 决定。",
};

const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });

export function CrashDumpsSection() {
  const api = window.amo?.crashDumps;
  const [info, setInfo] = useState<CrashDumpsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api?.get().then(setInfo, (err: unknown) => setMessage(String(err)));
  }, [api]);

  if (!api) return null;

  async function set(on: boolean | null) {
    setBusy(true);
    setMessage(null);
    try {
      setInfo(await api!.set(on));
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    const err = await api!.open();
    setMessage(err || null);
  }

  const changed = info && info.running !== info.next.on;
  return (
    <section className="settings-section" aria-label="崩溃转储">
      <span className="settings-heading">崩溃转储</span>
      {!info ? (
        <span className="settings-hint">读取中…</span>
      ) : (
        <>
          <label className="settings-row feature-row">
            <input type="checkbox" checked={info.next.on} disabled={busy || info.next.why === "env"} onChange={(e) => void set(e.target.checked)} data-testid="crash-dumps" />
            <span className="feature-text">
              <span className="settings-label">Studio 崩溃时留下转储文件</span>
              <span className="settings-hint">
                Studio 突然整个消失、或者某个窗口白掉时，把当时的内存快照写成一个 .dmp 文件，查原因用。只存在这台电脑上，不上传，只留最近 5 个。平时不占性能：只多一个几 MB 的后台小进程，崩溃时才写文件。文件里可能有当时的会话文字和路径，发给别人之前先想一下。改了之后下次打开 Studio 时生效。
              </span>
              <span className="settings-hint" data-testid="crash-dumps-state">
                {info.next.why === "setting" ? (
                  <>
                    你自己{info.setting ? "打开" : "关掉"}了它（默认是测试通道开、正式通道关）。{" "}
                    <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void set(null)} data-testid="crash-dumps-default">
                      恢复默认
                    </button>
                  </>
                ) : (
                  DEFAULT_TEXT[info.next.why]
                )}
                {changed ? ` 现在这次运行${info.running ? "开着" : "没开"}，下次打开 Studio 后${info.next.on ? "开启" : "关闭"}。` : ""}
              </span>
            </span>
          </label>
          <div className="settings-row">
            <span className="settings-label">文件夹</span>
            <code className="settings-hint maintenance-path" title={info.dir}>
              {info.dir}
            </code>
            <span className="spacer" />
            <button type="button" className="btn-ghost small" onClick={() => void open()} data-testid="crash-dumps-open">
              打开文件夹
            </button>
          </div>
          <span className="settings-hint" data-testid="crash-dumps-count">
            {info.count ? `现在有 ${info.count} 个转储，最新的是 ${time(info.newest!)}。` : "还没有转储。"}
          </span>
        </>
      )}
      {message && (
        <span className="form-error" role="alert">
          {message}
        </span>
      )}
    </section>
  );
}
