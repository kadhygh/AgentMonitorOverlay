import { useCallback, useEffect, useState, type ReactNode } from "react";
import { composeGitReviewMessage, type GitReviewComment, type StateSnapshot, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { sessionChoices } from "./logic.js";

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
 * The send bar: how many drafts the project has, the session they go to, and 发给会话. `target` is the chosen
 * session ("" for none); it only counts while it is a live session of the project.
 */
export function SendBar({
  link,
  state,
  workspace,
  comments,
  target,
  onTarget,
  busy,
  run,
  children,
}: {
  link: HostLink;
  state: StateSnapshot;
  workspace: Workspace;
  comments: readonly GitReviewComment[];
  target: string;
  onTarget(id: string): void;
  busy: boolean;
  /** Runs the send (the page shows it busy and reports a failure). */
  run(fn: () => Promise<unknown>): Promise<void>;
  /** More, after the count (显示已发送). */
  children?: ReactNode;
}) {
  const drafts = comments.filter((c) => c.state === "draft");
  const choices = sessionChoices(state, workspace.id, target);
  const chosen = choices.some((c) => c.id === target) ? target : "";
  const label = choices.find((c) => c.id === chosen)?.label ?? "";
  const send = () =>
    run(async () => {
      const r = await call(link, "POST /api/workspaces/:id/review-comments/send", { id: workspace.id }, { sessionId: chosen });
      showToast({ text: `已把 ${r.sent.length} 条批注发给「${label}」。` });
      commentsChanged(workspace.id);
    });
  return (
    <footer className="gr-bar">
      <span data-testid="review-draft-count">草稿批注 {drafts.length} 条</span>
      {children}
      <span className="spacer" />
      <label className="inline-field">
        发给
        <select value={chosen} onChange={(e) => onTarget(e.target.value)} data-testid="review-session" aria-label="发给哪个会话">
          <option value="">选择会话…</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn-primary"
        disabled={busy || !drafts.length || !chosen}
        title={drafts.length ? composeGitReviewMessage(drafts, workspace.name) : "还没有草稿批注"}
        onClick={() => void send()}
        data-testid="review-send"
      >
        发给会话{drafts.length ? `（${drafts.length}）` : ""}
      </button>
    </footer>
  );
}
