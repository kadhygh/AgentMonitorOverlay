import {
  composeGitReviewMessage,
  GIT_LOG_MAX,
  isCommitRef,
  isGitRange,
  isObjectId,
  rangeBase,
  sortComments,
  type GitChanges,
  type GitCommentRange,
  type GitCommitChanges,
  type GitFileDiff,
  type GitLog,
  type GitRange,
  type GitReviewComment,
  type GitStatus,
  type Id,
  type NewGitReviewComment,
} from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { SendMode } from "../../runtime/runtime.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { GitError, readChanges, readCommit, readCommitFileDiff, readFileDiff, readLog, readStatus } from "./git.js";

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
    // The status and the listing's untracked scan run side by side (readChanges starts the scan before waiting).
    return this.git(async () => readChanges(dir, r, readStatus(dir)));
  }

  /**
   * One file's diff. With the list's `base` (and whether the file is untracked) it is a single git call; without
   * them the status is read first (several calls).
   */
  async diff(workspaceId: Id, range: unknown, path: unknown, oldPath?: unknown, known: { base?: unknown; untracked?: unknown } = {}): Promise<GitFileDiff> {
    const r = this.range(range);
    if (typeof path !== "string" || !path) throw new HostError("bad_request", "path is required");
    if (known.base != null && known.base !== "" && !isObjectId(known.base)) throw new HostError("bad_request", "base must be a full commit id");
    const untracked = known.untracked === "1" ? true : known.untracked === "0" ? false : undefined;
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(async () => {
      const given = known.base;
      let base = isObjectId(given) ? given : null;
      if (!base) {
        const status = await readStatus(dir);
        if (!status.repo) throw new HostError("bad_request", status.reason ?? "不是 git 仓库");
        base = rangeBase(r, status);
      }
      return readFileDiff(dir, r, base, path, typeof oldPath === "string" && oldPath ? oldPath : undefined, untracked);
    });
  }

  /** HEAD's history, newest first (S13-B). */
  async log(workspaceId: Id, limit?: unknown): Promise<GitLog> {
    const n = limit === undefined || limit === null || limit === "" ? GIT_LOG_MAX : Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new HostError("bad_request", "limit must be a positive whole number");
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(async () => {
      try {
        return await readLog(dir, n);
      } catch (err) {
        // Only then the status: why there is no history (no git, not a repository).
        const status = await readStatus(dir);
        if (!status.repo) throw new HostError("bad_request", status.reason ?? "不是 git 仓库");
        throw err;
      }
    });
  }

  /** One commit's changed files against its first parent (S13-B). */
  async commit(workspaceId: Id, sha: unknown): Promise<GitCommitChanges> {
    if (!isCommitRef(sha)) throw new HostError("bad_request", "sha must be 7 to 64 hex digits");
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(() => readCommit(dir, sha));
  }

  /** One file of a commit, against the base its listing gave (S13-B). */
  async commitDiff(workspaceId: Id, sha: unknown, base: unknown, path: unknown, oldPath?: unknown): Promise<GitFileDiff> {
    if (!isObjectId(sha) || !isObjectId(base)) throw new HostError("bad_request", "sha and base must be full commit ids");
    if (typeof path !== "string" || !path) throw new HostError("bad_request", "path is required");
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(() => readCommitFileDiff(dir, base, sha, path, typeof oldPath === "string" && oldPath ? oldPath : undefined));
  }

  comments(workspaceId: Id): GitReviewComment[] {
    this.requireWorkspace(workspaceId);
    return this.store.listReviewComments(workspaceId);
  }

  addComment(workspaceId: Id, input: NewGitReviewComment): GitReviewComment {
    this.requireWorkspace(workspaceId);
    const range = this.commentRange(input?.range);
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 1000) throw new HostError("bad_request", "path is required");
    if (input.side !== "new" && input.side !== "old") throw new HostError("bad_request", "side must be new or old");
    // The viewer's 文件 mode (S14-A) shows the file as it is now: there is no old side.
    if (range === "file" && input.side !== "new") throw new HostError("bad_request", "a file comment is on the new side");
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

  /** A comment's range: a Git Review range, or `file` (the viewer's 文件 mode, S14-A). */
  private commentRange(v: unknown): GitCommentRange {
    return v === "file" ? "file" : this.range(v);
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
      if (err instanceof GitError) {
        if (err.kind === "failed" && / not found$/.test(err.message)) throw new HostError("not_found", err.message);
        throw new HostError(err.kind === "failed" && /path|bad commit|full commit/.test(err.message) ? "bad_request" : "runtime_error", err.message);
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("not_found", "file not found");
      throw new HostError("runtime_error", (err as Error).message ?? String(err));
    }
  }
}
