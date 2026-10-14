import { useEffect, useState } from "react";
import type { GitStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { openReview } from "./open.js";

export interface ProjectMenuAt {
  workspaceId: string;
  x: number;
  y: number;
}

/**
 * Right-click menu of a project in the left column: Git Review (only when the folder is a git repository), and
 * 归档项目 when the caller offers it.
 */
export function ProjectReviewMenu({ link, at, onClose, onArchive }: { link: HostLink; at: ProjectMenuAt; onClose(): void; onArchive?: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    let live = true;
    call(link, "GET /api/workspaces/:id/git/status", { id: at.workspaceId })
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link, at.workspaceId]);

  // Closes on Escape and on any click outside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(".ctx-menu") && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const notGit = status !== null && !status.repo;
  return (
    <div className="ctx-menu" role="menu" aria-label="项目" style={{ left: at.x, top: at.y }}>
      <button
        type="button"
        role="menuitem"
        disabled={!status?.repo}
        title={notGit ? status.reason : "查看项目的改动并逐行批注"}
        onClick={() => {
          openReview({ workspaceId: at.workspaceId });
          onClose();
        }}
      >
        Git Review{notGit ? `（${status.reason ?? "不是 git 仓库"}）` : ""}
      </button>
      {onArchive && (
        <button
          type="button"
          role="menuitem"
          title="项目和它的任务、会话一起归档，从列表里隐藏；可以在 设置 → 数据管理 里恢复"
          onClick={() => {
            onArchive();
            onClose();
          }}
          data-testid="archive-project"
        >
          归档项目…
        </button>
      )}
    </div>
  );
}
