import { useEffect, useState } from "react";
import type { FolderAccessStatus } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 项目与目录 → DSH 沙箱的文件夹权限 (2026-10-23): DSH's write sandbox needs the person's inherited full control
// of a project's folder (runtime/dsh/folder-access.ts). Pick a project, see how its folder stands, fix it with one
// click. The same fix the session notice offers; no elevation, the person owns the folder.

const STATE_LABELS: Record<FolderAccessStatus["state"], string> = {
  ok: "可以用",
  "needs-fix": "需要修复",
  unknown: "读不到",
  running: "正在修复…",
  failed: "修复没成功",
};

export function FolderAccessSection({ link }: { link: HostLink }) {
  const [list, setList] = useState<{ available: boolean; folders: FolderAccessStatus[] } | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    call(link, "GET /api/dsh/folders")
      .then((r) => {
        setList(r);
        setPicked((cur) => cur || (r.folders.find((f) => f.state === "needs-fix") ?? r.folders[0])?.workspaceId || "");
      })
      .catch((err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps

  // A fix runs on in the Host: read again until it is over.
  const running = list?.folders.some((f) => f.state === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list?.available) return null;
  const folder = list.folders.find((f) => f.workspaceId === picked);

  async function fix(id: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await call(link, "POST /api/dsh/folders/:workspaceId/fix", { workspaceId: id });
      setList((cur) => cur && { ...cur, folders: cur.folders.map((f) => (f.workspaceId === id ? next : f)) });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-label="DSH 沙箱的文件夹权限" data-testid="folder-access-section">
      <span className="settings-heading">DSH 沙箱的文件夹权限</span>
      <span className="settings-hint">
        DSH 的「写入」沙箱要你对项目文件夹有可继承的「完全控制」权限；只有「修改」时沙箱设不起来，命令会一条条来要你批准。修复给你自己加上这个文件夹及子文件夹的完全控制（原来的权限先备份），不用管理员；沙箱的防护不变，工程外照样写不进去。
      </span>
      <div className="settings-row">
        <select className="field" value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="项目" data-testid="folder-access-project">
          {list.folders.map((f) => (
            <option key={f.workspaceId} value={f.workspaceId}>
              {f.name} — {STATE_LABELS[f.state]}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost small" disabled={busy || running} onClick={() => void load()} data-testid="folder-access-recheck">
          重新检查
        </button>
        <button
          type="button"
          className="btn-primary small"
          disabled={!folder || busy || folder.state === "ok" || folder.state === "running"}
          onClick={() => folder && void fix(folder.workspaceId)}
          data-testid="folder-access-fix"
        >
          {folder?.state === "running" ? "正在修复…" : "一键修复"}
        </button>
      </div>
      {folder && (
        <span className={folder.state === "failed" ? "form-error" : "settings-hint"} data-testid="folder-access-state" data-state={folder.state}>
          {folder.path}：{STATE_LABELS[folder.state]}
          {folder.state === "running" ? "（文件多的项目要几分钟）" : ""}
          {folder.error ? `——${folder.error}` : ""}
          {folder.backup ? `。原来的权限备份在 ${folder.backup}` : ""}
        </span>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
