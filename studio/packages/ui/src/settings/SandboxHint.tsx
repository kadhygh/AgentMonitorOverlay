import { useEffect, useState } from "react";
import type { FolderAccessStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { FolderAccessDialog } from "./FolderAccessDialog.js";

// Under the permissions, when a DeepSeek · DSH session is to run with 工作区可写 in a project not set up for it
// (2026-10-23): what that means, 设置权限 (the dialog at that project) or 改用完全访问. Nothing shows otherwise —
// for other models, other permissions, a set-up project, or where Studio does not handle folders (not Windows).

/** The DSH permission that leaves the sandbox (runtime/choices.ts DSH_PERMISSIONS). */
export const DSH_FULL_ACCESS = "full-access";

export function SandboxHint({ link, workspaceId, active, onUseFull }: { link: HostLink; workspaceId: string | null | undefined; active: boolean; onUseFull?: () => void }) {
  const [folder, setFolder] = useState<FolderAccessStatus | null>(null);
  const [open, setOpen] = useState(false);

  const load = () => {
    if (!active || !workspaceId) return setFolder(null);
    call(link, "GET /api/dsh/folders/:workspaceId", { workspaceId })
      .then(setFolder)
      .catch(() => setFolder(null));
  };
  useEffect(load, [link, workspaceId, active]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active || !folder || folder.state === "ready" || folder.state === "unknown") return null;
  return (
    <div className="sandbox-hint" role="note" data-testid="sandbox-hint">
      <span className="state-dot warn" aria-hidden="true" />
      <span className="sandbox-hint-text">
        「{folder.name}」还没为 DSH 沙箱设置过权限：
        {folder.fullControl === false ? "沙箱设不起来，命令会一条条要你批准；" : "项目里的 exe 会降级运行；"}
        要用「工作区可写」，先设置一次。
      </span>
      <button type="button" className="btn-ghost small" onClick={() => setOpen(true)} data-testid="sandbox-hint-setup">
        设置权限…
      </button>
      {onUseFull && (
        <button type="button" className="btn-ghost small" onClick={onUseFull} data-testid="sandbox-hint-full">
          改用完全访问
        </button>
      )}
      {open && (
        <FolderAccessDialog
          link={link}
          focus={workspaceId}
          onClose={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}
