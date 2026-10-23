import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FolderAccessStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { relativeTime } from "../lib/status.js";

// DSH 沙箱权限 (2026-10-23): every project's folder as DeepSeek · DSH's 工作区可写 sandbox needs it, one row each, with
// 设置权限 and 重新扫描. Opened from 设置 → 项目与目录 and from the hint under 工作区可写 (`focus`: that project's row).
// What setting up does is in runtime/dsh/folder-access.ts; people who run DSH with 完全访问 never need this.

const STATE: Record<FolderAccessStatus["state"], string> = {
  ready: "已设置",
  unprepared: "未设置",
  unknown: "读不到",
  running: "处理中",
  failed: "失败",
};

/** The row's second line: what was found, the last scan, or what went wrong. */
export function folderDetail(f: FolderAccessStatus, now = new Date()): string {
  if (f.state === "running") return f.job === "scan" ? "正在扫描 exe…" : "正在设置…文件多的项目要几分钟";
  if (f.state === "failed") return f.error ?? "上次没成功";
  if (f.state === "unknown") return "读不到这个文件夹的权限";
  const scan = f.scannedAt ? `${f.exes ?? 0} 个 exe / dll 已设回正常 · ${relativeTime(f.scannedAt, now)}扫描` : "";
  if (f.state === "ready") return scan;
  return f.fullControl === false ? "缺可继承的完全控制：沙箱设不起来，命令会一条条要你批准" : "还没处理项目里的 exe";
}

export function FolderAccessDialog({ link, focus, onClose }: { link: HostLink; focus?: string | null; onClose(): void }) {
  const [list, setList] = useState<{ available: boolean; folders: FolderAccessStatus[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef<HTMLLIElement>(null);

  const load = () =>
    call(link, "GET /api/dsh/folders")
      .then(setList)
      .catch((err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => focused.current?.scrollIntoView({ block: "nearest" }), [list !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // A setup or scan runs on in the Host: read again until it is over.
  const running = list?.folders.some((f) => f.state === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(f: FolderAccessStatus, what: "fix" | "scan") {
    setBusy(f.workspaceId);
    setError(null);
    try {
      const next = await call(link, what === "fix" ? "POST /api/dsh/folders/:workspaceId/fix" : "POST /api/dsh/folders/:workspaceId/scan", { workspaceId: f.workspaceId });
      setList((cur) => cur && { ...cur, folders: cur.folders.map((x) => (x.workspaceId === next.workspaceId ? next : x)) });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="modal folder-access" role="dialog" aria-modal="true" aria-labelledby="folder-access-title" data-testid="folder-access-dialog">
        <div className="modal-head">
          <span className="modal-title" id="folder-access-title">
            DSH 沙箱权限
          </span>
          <span className="spacer" />
          <button type="button" className="btn-ghost small" disabled={running} onClick={() => void load()} data-testid="folder-access-recheck">
            重新检查
          </button>
          <button type="button" className="btn-ghost small" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="folder-access-intro">
          <p>只有想让 DeepSeek（DSH）在「工作区可写」沙箱里跑时才需要设置；用「完全访问」就不用管这里。</p>
          <p>
            「设置权限」做三件事：给你自己加上项目文件夹（含子文件夹）的 Windows 完全控制，原来的权限先备份；把项目标成低完整性，沙箱靠它把写入限制在项目里；把项目里的 exe 和 dll 设回正常（低完整性的 dll 会让 Electron、Chromium 一类程序的窗口崩溃）。不用管理员。
          </p>
          <p>
            之后在项目里新生成的文件都会继承低完整性，新生成的 exe 会降级运行、写不了项目外，新生成的 dll 可能加载不了。构建之后点「重新扫描」，或者把构建输出放到项目外的文件夹。「工作区可写」的会话每轮结束时也会自动补扫（同一项目最多 10 分钟一次）。
          </p>
        </div>
        {list && !list.available && <p className="settings-hint">这台机器上 Studio 不处理文件夹权限（只在 Windows 上）。</p>}
        {list?.available && (
          <ul className="folder-access-list" data-testid="folder-access-list">
            {list.folders.map((f) => (
              <li
                key={f.workspaceId}
                ref={f.workspaceId === focus ? focused : undefined}
                className={f.workspaceId === focus ? "focused" : undefined}
                data-testid="folder-access-row"
                data-state={f.state}
              >
                <div className="fa-main">
                  <span className="fa-name">{f.name}</span>
                  <span className="fa-path" title={f.path}>
                    {f.path}
                  </span>
                  <span className={`fa-detail${f.state === "failed" ? " error" : ""}`} title={f.backup ? `原来的权限备份在 ${f.backup}` : undefined}>
                    {folderDetail(f)}
                  </span>
                </div>
                <span className={`fa-state ${f.state}`}>{STATE[f.state]}</span>
                <div className="fa-actions">
                  {f.state === "ready" || (f.state === "running" && f.job === "scan") ? (
                    <button type="button" className="btn-ghost small" disabled={busy === f.workspaceId || f.state === "running"} onClick={() => void act(f, "scan")} data-testid="folder-access-scan">
                      {f.state === "running" ? "扫描中…" : "重新扫描"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary small"
                      disabled={busy === f.workspaceId || f.state === "running" || f.state === "unknown"}
                      onClick={() => void act(f, "fix")}
                      data-testid="folder-access-fix"
                    >
                      {f.state === "running" ? "设置中…" : f.state === "failed" ? "再试一次" : "设置权限"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!list && !error && <p className="settings-hint">正在读取各项目的权限…</p>}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
