import { useMemo } from "react";
import type { SessionItem } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { IconFile } from "../attach/icons.js";
import { openReview, useIsGitRepo } from "../gitreview/open.js";
import { turnChanges, type ChangedFile } from "./changes.js";
import { useExistingPath } from "./exists.js";
import { useFileLinks, type PreviewTarget } from "./FileLinks.js";
import { fileName, folderOf } from "./paths.js";

// Under a finished turn's reply (stage 12, S12-C, after DSH's changed-files card): the files the turn changed with
// their line counts. A click shows the file's change in this turn in the quick look; 在 Review 里看 opens Git Review.

export function TurnChanges({ items }: { items: readonly SessionItem[] }) {
  const ctx = useFileLinks();
  const files = useMemo(() => turnChanges(items), [items]);
  if (!ctx || !files.length) return null;
  return <ChangesCard link={ctx.link} workspaceId={ctx.workspaceId} sessionId={ctx.sessionId} files={files} />;
}

function ChangesCard({ link, workspaceId, sessionId, files }: { link: HostLink; workspaceId: string | null; sessionId: string | null; files: ChangedFile[] }) {
  const repo = useIsGitRepo(link, workspaceId);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="turn-changes" data-testid="turn-changes">
      <div className="tc-head">
        <span className="tc-title">改动了 {files.length} 个文件</span>
        {(added > 0 || removed > 0) && (
          <span className="tc-stat">
            <span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        )}
        <span className="spacer" />
        {repo && workspaceId && (
          <button type="button" className="tc-review" onClick={() => openReview({ workspaceId, ...(sessionId ? { sessionId } : {}) })} data-testid="turn-changes-review">
            在 Review 里看
          </button>
        )}
      </div>
      {files.map((f) => (
        <ChangeRow key={f.path} file={f} />
      ))}
    </div>
  );
}

function ChangeRow({ file }: { file: ChangedFile }) {
  const ctx = useFileLinks()!;
  // The absolute path once known (a deleted file keeps its name relative to the project).
  const found = useExistingPath(ctx.link, { workspaceId: ctx.workspaceId }, file.path);
  const target: PreviewTarget = { file: found ? { path: found.path } : { path: file.path, ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}) }, diff: file };
  return (
    <button
      type="button"
      className="tc-row"
      data-testid="turn-change"
      title={`${found?.path ?? file.path}\n点击查看这一轮的改动 · 右键更多`}
      onClick={(e) => (e.ctrlKey || e.metaKey ? ctx.editor({ file: target.file }) : ctx.preview(target))}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.menu(e, { file: target.file });
      }}
    >
      <IconFile />
      <span className="tc-name">{fileName(file.path)}</span>
      {folderOf(file.path) && <span className="tc-dir">{folderOf(file.path)}</span>}
      {file.change !== "update" && <span className="tc-tag">{file.change === "add" ? "新文件" : "已删除"}</span>}
      <span className="tc-row-stat">
        {file.added > 0 && <span className="add">+{file.added}</span>} {file.removed > 0 && <span className="del">−{file.removed}</span>}
      </span>
    </button>
  );
}
