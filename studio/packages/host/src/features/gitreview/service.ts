import {
  composeGitReviewMessage,
  GIT_LOG_MAX,
  isCommitRef,
  isGitRange,
  isObjectId,
  PASSAGE_CONTEXT,
  rangeBase,
  sortComments,
  type GitChanges,
  type GitCommentPassage,
  type GitCommentRange,
  type GitCommitChanges,
  type GitFileDiff,
  type GitLog,
  type GitRange,
  type GitReviewComment,
  type GitStatus,
  type Id,
  type NewGitReviewComment,
  type ReviewOpenRequest,
  type ReviewOpenResult,
  type ReviewOpenTarget,
  type Workspace,
} from "@amo-studio/protocol";
import { isAbsolute, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { newId } from "../../store/store.js";
import type { SendMode } from "../../runtime/runtime.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { GitError, mergeBase, readChanges, readCommit, readCommitFileDiff, readFileDiff, readLog, readStatus, resolveCommit } from "./git.js";

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

  /**
   * The changed files of a range. `base` (a full id, with the branch range; 外部打开 Review) replaces the merge base, and
   * `label` names it where the default branch's name would show.
   */
  async changes(workspaceId: Id, range: unknown, base?: unknown, label?: unknown): Promise<GitChanges> {
    const r = this.range(range);
    const own = base === undefined || base === null || base === "" ? null : base;
    if (own !== null && !isObjectId(own)) throw new HostError("bad_request", "base must be a full commit id");
    if (own !== null && r !== "branch") throw new HostError("bad_request", "base goes with the branch range");
    const dir = this.requireWorkspace(workspaceId).path;
    const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : own?.slice(0, 7);
    const status = own ? readStatus(dir).then((s): GitStatus => (s.repo ? { ...s, mergeBase: own, base: name ?? own } : s)) : readStatus(dir);
    // The status and the listing's untracked scan run side by side (readChanges starts the scan before waiting).
    return this.git(async () => readChanges(dir, r, status));
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
  async commit(workspaceId: Id, sha: unknown, base?: unknown): Promise<GitCommitChanges> {
    if (!isCommitRef(sha)) throw new HostError("bad_request", "sha must be 7 to 64 hex digits");
    if (base !== undefined && base !== null && base !== "" && !isObjectId(base)) throw new HostError("bad_request", "base must be a full commit id");
    const dir = this.requireWorkspace(workspaceId).path;
    return this.git(() => readCommit(dir, sha, typeof base === "string" && base ? base : undefined));
  }
  /**
   * 外部打开 Review (2026-10-18): another tool (a harness, a script) asks the open Studio to show a project's changes.
   * The project is found by its folder (registered when new) or its id. What to show:
   * - nothing: the uncommitted changes (工作区), comments allowed;
   * - `base`: the working tree against that ref (the 本分支 view with this base), comments allowed;
   * - `commit`: that commit, read-only; with `base`, the commit against it;
   * - `range` `A..B` (B against A) or `A...B` (B against where it left A), read-only.
   * Refs are branch names, tags, `HEAD~2` or ids; they are resolved here, so the window gets full ids. `sessionId` is
   * where 发回 sends the comments. The main window opens the review window when it receives the event.
   */
  async openReview(input: Partial<ReviewOpenRequest>): Promise<ReviewOpenResult> {
    if (!this.host.liveWindows) throw new HostError("conflict", "AMO Studio 的窗口没有打开：先启动 AMO Studio，再打开 Review");
    const text = (v: unknown, name: string): string | undefined => {
      if (v === undefined || v === null || v === "") return undefined;
      if (typeof v !== "string" || !v.trim() || v.length > 1000 || /[\0\r\n]/.test(v)) throw new HostError("bad_request", `${name} must be a non-empty string without control characters`);
      return v.trim();
    };
    const mode = input.mode ?? "changes";
    if (mode !== "file" && mode !== "changes") throw new HostError("bad_request", "mode must be file or changes");
    const file = text(input.file, "file");
    if (mode === "file" && !file) throw new HostError("bad_request", "file mode requires file");
    if (mode === "file" && (input.base || input.commit || input.range)) throw new HostError("bad_request", "file mode shows the current file, without base, commit or range");
    for (const name of ["line", "endLine"] as const) {
      const n = input[name];
      if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw new HostError("bad_request", `${name} must be a positive whole number`);
    }
    if ((input.line !== undefined || input.endLine !== undefined) && mode !== "file") throw new HostError("bad_request", "line and endLine go with file mode");
    if (input.endLine !== undefined && (input.line === undefined || input.endLine < input.line)) throw new HostError("bad_request", "endLine requires line and must be at least line");
    const id = text(input.workspaceId, "workspaceId");
    const folder = text(input.path, "path");
    if (id && folder) throw new HostError("bad_request", "use path or workspaceId, not both");
    if (!id && !folder) throw new HostError("bad_request", "path (the project's folder) or workspaceId is required");
    let workspace = id ? this.requireWorkspace(id) : this.store.findWorkspaceByPath(resolve(folder!));
    if (workspace?.archivedAt) throw new HostError("conflict", `这个文件夹是已归档的项目「${workspace.name}」，到 设置 → 数据管理 里恢复它`);
    const dir = workspace?.path ?? resolve(folder!);
    if (!workspace && !(await stat(dir).catch(() => null))?.isDirectory()) throw new HostError("bad_request", `not a directory: ${dir}`);

    let commit = text(input.commit, "commit");
    let base = text(input.base, "base");
    let forked = false;
    const range = text(input.range, "range");
    if (range) {
      if (commit || base) throw new HostError("bad_request", "range goes alone, without commit or base");
      const m = /^(.+?)(\.\.\.?)(.+)$/.exec(range);
      if (!m) throw new HostError("bad_request", "range is A..B or A...B");
      [base, commit, forked] = [m[1]!, m[3]!, m[2] === "..."];
    }
    const sessionId = text(input.sessionId, "sessionId");
    if (sessionId && !this.store.getSession(sessionId)) throw new HostError("not_found", `session ${sessionId} not found`);
    let relativeFile = file ? relative(dir, resolve(dir, file)).replace(/\\/g, "/") : undefined;
    if (relativeFile !== undefined && (!relativeFile || relativeFile === ".." || relativeFile.startsWith("../") || isAbsolute(relativeFile))) {
      throw new HostError("bad_request", "file must be inside the project folder");
    }
    if (mode === "file") {
      const info = await stat(resolve(dir, relativeFile!)).catch(() => null);
      if (!info) throw new HostError("not_found", `file ${file} not found`);
      if (!info.isFile()) throw new HostError("bad_request", "file must be a file, not a folder");
    }
    const resolved = await this.git(async (): Promise<Omit<ReviewOpenTarget, "workspaceId">> => {
      const head = commit ? await resolveCommit(dir, commit) : undefined;
      let from = base ? await resolveCommit(dir, base) : undefined;
      if (forked && from && head) from = await mergeBase(dir, from, head);
      if (mode === "changes" && relativeFile) {
        const status = head ? null : await readStatus(dir);
        if (status && !status.repo) throw new HostError("bad_request", status.reason ?? "不是 git 仓库");
        const changes = head ? await readCommit(dir, head, from) : await readChanges(dir, from ? "branch" : "working", from ? { ...status!, mergeBase: from } : status!);
        const key = relativeFile.toLowerCase();
        const hit = changes.files.find((f) => f.path.toLowerCase() === key) ?? changes.files.find((f) => f.oldPath?.toLowerCase() === key);
        if (!hit) throw new HostError("not_found", changes.truncated ? "指定文件不在已列出的改动中（改动列表已截断）" : "指定文件在这个范围内没有改动；查看当前文件请用 mode=file");
        relativeFile = hit.path;
      }
      return {
        ...(sessionId ? { sessionId } : {}),
        ...(head ? { commit: head } : {}),
        ...(from ? { base: from, baseLabel: forked ? `${base} 的分叉点` : base! } : {}),
        ...(relativeFile ? { file: relativeFile } : {}),
        ...(input.mode ? { mode } : {}),
        ...(input.line !== undefined ? { line: input.line } : {}),
        ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
      };
    });
    // A refused request must not leave a newly registered project behind.
    workspace ??= this.store.findWorkspaceByPath(dir);
    if (workspace?.archivedAt) throw new HostError("conflict", "这个项目已归档，请先恢复它");
    const workspaceAdded = !workspace;
    workspace ??= this.f.projects.addWorkspace({ path: dir });
    const target: ReviewOpenTarget = { workspaceId: workspace.id, ...resolved };
    this.publish({ type: "review.open", target, at: new Date().toISOString() });
    return { target, workspaceAdded };
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
    const passage = this.passage(input.passage, range);
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
      ...(passage ? { passage } : {}),
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
  /**
   * 复制注释 (2026-10-23): the drafts as the text a session got before, for the person to copy; they leave the drafts
   * (marked sent, to no session). Picking a session to send them to added nothing.
   */
  copy(workspaceId: Id, ids?: unknown): { text: string; sent: GitReviewComment[] } {
    const ws = this.requireWorkspace(workspaceId);
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === "string"))) throw new HostError("bad_request", "ids must be a list of comment ids");
    const wanted = ids ? new Set(ids as string[]) : null;
    const drafts = sortComments(this.store.listReviewComments(workspaceId).filter((c) => c.state === "draft" && (!wanted || wanted.has(c.id))));
    if (!drafts.length) throw new HostError("bad_request", "no comments to copy");
    const text = composeGitReviewMessage(drafts, ws.name);
    const at = new Date().toISOString();
    const sent = drafts.map((c) => {
      const next: GitReviewComment = { ...c, state: "sent", sessionId: null, sentAt: at, updatedAt: at };
      this.store.putReviewComment(next);
      return next;
    });
    return { text, sent };
  }

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

  /** 渲染批注 (2026-10-28): a passage of the file as shown rendered, only in the viewer's 文件 mode. */
  private passage(v: unknown, range: GitCommentRange): GitCommentPassage | undefined {
    if (v === undefined || v === null) return undefined;
    if (range !== "file" || typeof v !== "object") throw new HostError("bad_request", "a passage is on a file in the viewer");
    const p = v as Record<string, unknown>;
    const text = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
    const quote = text(p.quote, LINE_TEXT_MAX).trim();
    if (!quote) throw new HostError("bad_request", "a passage needs its words");
    const source = text(p.source, 1000).trim();
    return { quote, prefix: text(p.prefix, PASSAGE_CONTEXT * 2), suffix: text(p.suffix, PASSAGE_CONTEXT * 2), ...(source ? { source } : {}) };
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
