import { useEffect, useState } from "react";
import type { GitStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { openReview } from "./open.js";

export interface ProjectMenuAt {
  workspaceId: string;
  x: number;
  y: number;
}

/** 项目分组 in the menu (2026-10-22): the groups, the project's own, and what picking one does. */
export interface ProjectMenuGroups {
  groups: ReadonlyArray<{ id: string; name: string }>;
  current: string | null;
  onJoin(groupId: string): void;
  onNew(): void;
  onLeave(): void;
}

/**
 * Right-click menu of a project in the left column: Git Review (only when the folder is a git repository), and
 * 编辑项目, 加入分组 / 移出分组 and 归档项目 when the caller offers them.
 */
export function ProjectReviewMenu({ link, at, onClose, onArchive, onEdit, groups }: { link: HostLink; at: ProjectMenuAt; onClose(): void; onArchive?: () => void; onEdit?: () => void; groups?: ProjectMenuGroups }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [joining, setJoining] = useState(false);
  const pick = (run: () => void) => () => {
    run();
    onClose();
  };
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
      {onEdit && (
        <button
          type="button"
          role="menuitem"
          title="改项目在 AMO 里的名字，写一段说明（agent 也能读到）"
          onClick={() => {
            onEdit();
            onClose();
          }}
          data-testid="edit-project-item"
        >
          编辑项目…
        </button>
      )}
      {groups && (
        <>
          <button type="button" role="menuitem" aria-expanded={joining} onClick={() => setJoining((v) => !v)} title="把项目放进一个分组，左栏里按分组折叠" data-testid="join-group-item">
            加入分组
            <span className="menu-sub-arrow" aria-hidden="true">
              {joining ? "▾" : "▸"}
            </span>
          </button>
          {joining && (
            <div className="menu-sub" role="group" aria-label="分组">
              {groups.groups.map((g) => (
                <button key={g.id} type="button" role="menuitemradio" aria-checked={g.id === groups.current} onClick={pick(() => g.id !== groups.current && groups.onJoin(g.id))} data-testid="join-group">
                  <span className="menu-check" aria-hidden="true">
                    {g.id === groups.current ? "✓" : ""}
                  </span>
                  {g.name}
                </button>
              ))}
              {groups.groups.length > 0 && <hr className="menu-rule" />}
              <button type="button" role="menuitem" className="menu-new" onClick={pick(groups.onNew)} data-testid="new-group-item">
                ＋ 新建分组…
              </button>
            </div>
          )}
          {groups.current && (
            <button type="button" role="menuitem" onClick={pick(groups.onLeave)} title="项目回到没分组的那一段" data-testid="leave-group-item">
              移出分组
            </button>
          )}
        </>
      )}
      {onArchive && (
        <button
          type="button"
          role="menuitem"
          className="menu-danger"
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
