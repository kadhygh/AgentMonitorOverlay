import { useCallback, useEffect, useState, type ReactNode } from "react";
import { composeGitReviewMessage, type GitReviewComment, type Workspace } from "@amo-studio/protocol";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";

// A project's review comments, shared by every view of them in a window (S14-A): Review, and the viewer's 文件 and
// 改动 modes, which write to the same drafts. A change in one view reloads the others; coming back to the window
// reloads too (another window may have written).

const bus = new EventTarget();

/** Comments of the project changed: every view of them reads them again. */
export function commentsChanged(workspaceId: string): void {
  bus.dispatchEvent(new CustomEvent("changed", { detail: workspaceId }));
}

export function useReviewComments(link: HostLink, workspaceId: string, enabled = true) {
  const [comments, setComments] = useState<readonly GitReviewComment[]>([]);
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve();
    return call(link, "GET /api/workspaces/:id/review-comments", { id: workspaceId })
      .then(setComments)
      .catch((err: unknown) => showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true }));
  }, [link, workspaceId, enabled]);
  useEffect(() => {
    void load();
    const onChanged = (e: Event) => (e as CustomEvent<string>).detail === workspaceId && void load();
    const onFocus = () => void load();
    bus.addEventListener("changed", onChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      bus.removeEventListener("changed", onChanged);
      window.removeEventListener("focus", onFocus);
    };
  }, [load, workspaceId]);
  return comments;
}

/**
 * The comment bar (2026-10-23, in place of 发给会话 and its session picker): how many drafts the project has, and
 * 复制注释 / 复制并关闭. The text is what a session got before (file, line, the line's text, the note); copied drafts
 * are marked sent and leave the list. The person pastes them wherever the work goes on.
 */
export function SendBar({
  link,
  workspace,
  comments,
  busy,
  run,
  children,
}: {
  link: HostLink;
  workspace: Workspace;
  comments: readonly GitReviewComment[];
  busy: boolean;
  /** Runs the copy (the page shows it busy and reports a failure). */
  run(fn: () => Promise<unknown>): Promise<void>;
  /** More, after the count (显示已发送). */
  children?: ReactNode;
}) {
  const drafts = comments.filter((c) => c.state === "draft");
  const copy = (close: boolean) =>
    run(async () => {
      const r = await call(link, "POST /api/workspaces/:id/review-comments/copy", { id: workspace.id }, {});
      await copyText(r.text);
      showToast({ text: `已复制 ${r.sent.length} 条批注，可以粘贴给需要的对话或工具。` });
      commentsChanged(workspace.id);
      if (close) window.close();
    });
  const preview = drafts.length ? composeGitReviewMessage(drafts, workspace.name) : "还没有草稿批注";
  return (
    <footer className="gr-bar">
      <span data-testid="review-draft-count">草稿批注 {drafts.length} 条</span>
      {children}
      <span className="spacer" />
      <button type="button" className="btn-ghost" disabled={busy || !drafts.length} title={preview} onClick={() => void copy(false)} data-testid="review-copy">
        复制注释{drafts.length ? `（${drafts.length}）` : ""}
      </button>
      <button type="button" className="btn-primary" disabled={busy || !drafts.length} title={preview} onClick={() => void copy(true)} data-testid="review-copy-close">
        复制并关闭
      </button>
    </footer>
  );
}
