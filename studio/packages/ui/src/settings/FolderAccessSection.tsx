import { useEffect, useState } from "react";
import type { FolderAccessStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { FolderAccessDialog } from "./FolderAccessDialog.js";

// 设置 → 项目与目录 → DSH 沙箱权限 (2026-10-23): how many projects are set up for DSH's 工作区可写 sandbox, and the
// dialog that lists them all (FolderAccessDialog).

export function FolderAccessSection({ link }: { link: HostLink }) {
  const [list, setList] = useState<{ available: boolean; folders: FolderAccessStatus[] } | null>(null);
  const [open, setOpen] = useState(false);

  const load = () =>
    call(link, "GET /api/dsh/folders")
      .then(setList)
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list?.available) return null;
  const ready = list.folders.filter((f) => f.state === "ready").length;

  return (
    <section className="settings-section" aria-label="DSH 沙箱权限" data-testid="folder-access-section">
      <span className="settings-heading">DSH 沙箱权限</span>
      <span className="settings-hint">
        想让 DeepSeek（DSH）在「工作区可写」沙箱里跑，项目文件夹要先设置一次 Windows 权限，并处理好里面的 exe。用「完全访问」就不用管。
      </span>
      <div className="settings-row">
        <span className="settings-label" data-testid="folder-access-summary">
          {ready} / {list.folders.length} 个项目已设置
        </span>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={() => setOpen(true)} data-testid="folder-access-open">
          管理…
        </button>
      </div>
      {open && (
        <FolderAccessDialog
          link={link}
          onClose={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
