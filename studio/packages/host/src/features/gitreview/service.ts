import { composeGitReviewMessage, isGitRange, sortComments, type GitChanges, type GitFileDiff, type GitRange, type GitReviewComment, type GitStatus, type Id, type NewGitReviewComment } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { SendMode } from "../../runtime/runtime.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { GitError, readChanges, readFileDiff, readStatus } from "./git.js";

const NOTE_MAX = 10_000;
const LINE_TEXT_MAX = 2_000;

/**
 * Git Review (stage 11, S11-D): a project's changes as git sees them (status, changed files of a range, one file's
 * diff), comments on their lines, and sending the comments to a session as one message grouped by file.
 */
export class GitReviewFeature extends Feature {
  async status(workspaceId: Id): Promise<GitStatus> {
    return this.git(() => readStatus(this.requireWorkspace(workspaceId).path));
  }

  async changes(workspaceId: Id, range: unknown): Promise<GitChanges> {
    const r = this.range(range);
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(async () => readChanges(dir, r, await readStatus(dir)));
  }

  async diff(workspaceId: Id, range: unknown, path: unknown, oldPath?: unknown): Promise<GitFileDiff> {
    const r = this.range(range);
    if (typeof path !== "string" || !path) throw new HostError("bad_request", "path is required");
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(async () => {
      const status = await readStatus(dir);
      if (!status.repo) throw new HostError("bad_request", status.reason ?? "不是 git 仓库");
      return readFileDiff(dir, r, status, path, typeof oldPath === "string" && oldPath ? oldPath : undefined);
    });
  }

  comments(workspaceId: Id): GitReviewComment[] {
    this.requireWorkspace(workspaceId);
    return this.store.listReviewComments(workspaceId);
  }

  addComment(workspaceId: Id, input: NewGitReviewComment): GitReviewComment {
    this.requireWorkspace(workspaceId);
    const range = this.range(input?.range);
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 1000) throw new HostError("bad_request", "path is required");
    if (input.side !== "new" && input.side !== "old") throw new HostError("bad_request", "side must be new or old");
    const line = Number(input.line);
    if (!Number.isInteger(line) || line < 1) throw new HostError("bad_request", "line must be a line number");
    const note = this.note(input.note);
    const at = new Date().toISOString();
    const comment: GitReviewComment = {
      id: newId("rc"),
      workspaceId,
      range,
      path,
      side: input.side,
      line,
      lineText: typeof input.lineText === "string" ? input.lineText.slice(0, LINE_TEXT_MAX) : "",
      note,
      state: "draft",
      sessionId: null,
      createdAt: at,
      updatedAt: at,
      sentAt: null,
    };
    this.store.putReviewComment(comment);
    return comment;
  }

  updateComment(id: Id, note: unknown): GitReviewComment {
    const current = this.requireComment(id);
    if (current.state === "sent") throw new HostError("conflict", "sent comments cannot be edited");
    const next = { ...current, note: this.note(note), updatedAt: new Date().toISOString() };
    this.store.putReviewComment(next);
    return next;
  }

  deleteComment(id: Id): void {
    this.requireComment(id);
    this.store.deleteReviewComment(id);
  }

  /** Sends the drafts (all, or the ones named) to a session as one message grouped by file, and marks them sent. */
  async send(workspaceId: Id, sessionId: unknown, ids?: unknown): Promise<{ mode: SendMode; sent: GitReviewComment[] }> {
    const ws = this.requireWorkspace(workspaceId);
    if (typeof sessionId !== "string" || !sessionId) throw new HostError("bad_request", "sessionId is required");
    const session = this.requireSession(sessionId);
    if (session.archivedAt) throw new HostError("read_only", "the session is archived");
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === "string"))) throw new HostError("bad_request", "ids must be a list of comment ids");
    const wanted = ids ? new Set(ids as string[]) : null;
    const drafts = sortComments(this.store.listReviewComments(workspaceId).filter((c) => c.state === "draft" && (!wanted || wanted.has(c.id))));
    if (!drafts.length) throw new HostError("bad_request", "no comments to send");
    const result = await this.f.sessions.sendMessage(session.id, composeGitReviewMessage(drafts, ws.name));
    const at = new Date().toISOString();
    const sent = drafts.map((c) => {
      const next: GitReviewComment = { ...c, state: "sent", sessionId: session.id, sentAt: at, updatedAt: at };
      this.store.putReviewComment(next);
      return next;
    });
    return { mode: result.mode, sent };
  }

  private range(v: unknown): GitRange {
    if (v === undefined || v === null || v === "") return "working";
    if (!isGitRange(v)) throw new HostError("bad_request", `unknown range ${String(v)}`);
    return v;
  }

  private note(v: unknown): string {
    const note = typeof v === "string" ? v.trim() : "";
    if (!note) throw new HostError("bad_request", "note is required");
    if (note.length > NOTE_MAX) throw new HostError("bad_request", `note is limited to ${NOTE_MAX} characters`);
    return note;
  }

  private requireComment(id: Id): GitReviewComment {
    const c = this.store.getReviewComment(id);
    if (!c) throw new HostError("not_found", `review comment ${id} not found`);
    return c;
  }

  /** git failures as Host errors: a bad request for paths, a runtime error otherwise. */
  private async git<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HostError) throw err;
      if (err instanceof GitError) throw new HostError(err.kind === "failed" && /path/.test(err.message) ? "bad_request" : "runtime_error", err.message);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("not_found", "file not found");
      throw new HostError("runtime_error", (err as Error).message ?? String(err));
    }
  }
}
