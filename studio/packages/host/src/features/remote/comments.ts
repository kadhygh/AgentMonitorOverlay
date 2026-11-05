import { composeRemoteReviewMessage, sortComments, type GitReviewComment, type Id, type NewGitReviewComment, type Task } from "@amo-studio/protocol";
import type { FeatureHost } from "../../core/feature.js";
import type { RemoteUses } from "./service.js";
import { HostError } from "../../core/shared.js";

// 远程 Reviewer 的批注 (plans/remote-reviewer.md step 3, 2026-11-02, the user): B's comments on a remote task's files
// and changes stay on B — the task's computer never sees them as comments. B has no project of A's (review_comments
// belongs to a project), so each copy keeps its own list beside it, in the kv table, gone with the copy. The windows
// write them as they write any comments (the same routes, through /api/remote/view/<task>/…); copied out, the paths
// start at 任务文件夹/; 发到对话 sends them into a session of the copy, which goes to A as a message (rt.send).

const KEY = "remote.review-comments:";
/** Comments a copy keeps at most (drafts and sent); the oldest sent go first. */
const MAX_COMMENTS = 1000;

const WS = String.raw`[^/]{1,200}`;
const ROUTES: Array<{ method: string; re: RegExp; name: "list" | "add" | "copy" | "send" | "edit" | "delete" }> = [
  { method: "GET", re: new RegExp(`^/api/workspaces/(${WS})/review-comments$`), name: "list" },
  { method: "POST", re: new RegExp(`^/api/workspaces/(${WS})/review-comments$`), name: "add" },
  { method: "POST", re: new RegExp(`^/api/workspaces/(${WS})/review-comments/copy$`), name: "copy" },
  { method: "POST", re: new RegExp(`^/api/workspaces/(${WS})/review-comments/send$`), name: "send" },
  { method: "PATCH", re: /^\/api\/review-comments\/([\w-]{1,80})$/, name: "edit" },
  { method: "DELETE", re: /^\/api\/review-comments\/([\w-]{1,80})$/, name: "delete" },
];

export class RemoteComments {
  constructor(private readonly host: () => FeatureHost<RemoteUses>) {}

  private get store() {
    return this.host().store;
  }

  /** The copy's comments, oldest first. */
  list(taskId: Id): GitReviewComment[] {
    const raw = this.store.getKv(KEY + taskId)?.value;
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? (v as GitReviewComment[]) : [];
    } catch {
      return [];
    }
  }

  private save(taskId: Id, list: GitReviewComment[]): void {
    let kept = list;
    while (kept.length > MAX_COMMENTS) {
      const sent = kept.findIndex((c) => c.state === "sent");
      if (sent < 0) throw new HostError("bad_request", `一个远程任务最多留 ${MAX_COMMENTS} 条批注：先复制或删掉一些`);
      kept = kept.filter((_, i) => i !== sent);
    }
    this.store.setKv(KEY + taskId, JSON.stringify(kept));
  }

  /** The copy is deleted (归档): its comments go with it. */
  drop(taskId: Id): void {
    this.store.deleteKv(KEY + taskId);
  }

  /** Whether a Reviewer request is about comments (answered here, never passed on to the task's computer). */
  handles(method: string, path: string): boolean {
    return ROUTES.some((r) => r.method === method && r.re.test(path));
  }

  /** A comment request of a remote task's Reviewer window, answered from the copy's list. */
  async answer(task: Task, method: string, path: string, body: unknown): Promise<unknown> {
    const hit = ROUTES.map((r) => ({ r, m: r.method === method ? r.re.exec(path) : null })).find((x) => x.m);
    if (!hit) throw new HostError("not_found", "这不是批注的请求");
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const m = hit.m!;
    const list = this.list(task.id);
    switch (hit.r.name) {
      case "list":
        return list;
      case "add": {
        const c = this.host().gitReview.draftComment(decodeURIComponent(m[1]!), body as NewGitReviewComment);
        this.save(task.id, [...list, c]);
        return c;
      }
      case "edit": {
        const i = this.index(list, m[1]!);
        const next = this.host().gitReview.editedComment(list[i]!, b.note);
        this.save(task.id, list.map((c, j) => (j === i ? next : c)));
        return next;
      }
      case "delete": {
        const i = this.index(list, m[1]!);
        this.save(task.id, list.filter((_, j) => j !== i));
        return { ok: true };
      }
      case "copy": {
        const drafts = this.drafts(list, b.ids, "no comments to copy");
        const text = composeRemoteReviewMessage(drafts, task.remote?.name ?? "", true);
        return { text, sent: this.markSent(task.id, list, drafts, null) };
      }
      case "send": {
        const sessionId = b.sessionId;
        if (typeof sessionId !== "string" || !sessionId) throw new HostError("bad_request", "sessionId is required");
        const session = this.store.getSession(sessionId);
        // Only into a conversation of this task (the windows send to the pack's, or the one that opened them).
        if (!session || session.taskId !== task.id) throw new HostError("bad_request", "只能发到这个远程任务自己的对话里");
        if (session.archivedAt) throw new HostError("read_only", "这个对话已经归档了");
        const drafts = this.drafts(list, b.ids, "no comments to send");
        const result = await this.host().sessions.sendMessage(session.id, composeRemoteReviewMessage(drafts, task.remote?.name ?? "", false));
        // Read again: comments written while it was on its way stay.
        return { mode: result.mode, sent: this.markSent(task.id, this.list(task.id), drafts, session.id) };
      }
    }
  }

  private index(list: GitReviewComment[], id: string): number {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) throw new HostError("not_found", `review comment ${id} not found`);
    return i;
  }

  private drafts(list: GitReviewComment[], ids: unknown, none: string): GitReviewComment[] {
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === "string"))) throw new HostError("bad_request", "ids must be a list of comment ids");
    const wanted = ids ? new Set(ids as string[]) : null;
    const drafts = sortComments(list.filter((c) => c.state === "draft" && (!wanted || wanted.has(c.id))));
    if (!drafts.length) throw new HostError("bad_request", none);
    return drafts;
  }

  private markSent(taskId: Id, list: GitReviewComment[], drafts: GitReviewComment[], sessionId: Id | null): GitReviewComment[] {
    const at = new Date().toISOString();
    const ids = new Set(drafts.map((c) => c.id));
    const sent: GitReviewComment[] = [];
    const next = list.map((c) => {
      if (!ids.has(c.id)) return c;
      const s: GitReviewComment = { ...c, state: "sent", sessionId, sentAt: at, updatedAt: at };
      sent.push(s);
      return s;
    });
    this.save(taskId, next);
    return sent;
  }
}
