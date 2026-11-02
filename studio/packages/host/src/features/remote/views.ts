import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import {
  GIT_LOG_MAX,
  MAX_EXISTS_PATHS,
  REMOTE_FILE_CHUNK,
  REMOTE_KINDS,
  REMOTE_TASK_FOLDER,
  REMOTE_VIEW_MAX_BYTES,
  type ExistingPath,
  type GitChangedFile,
  type GitChanges,
  type GitStatus,
  type Id,
  type RemoteViewAnswer,
  type RemoteViewAsk,
  type Task,
  type TextFile,
  type ViewPack,
} from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import type { HostService } from "../../service.js";
import { HostError } from "../../core/shared.js";
import type { RemoteContext } from "./grants.js";
import { insideFolder, real, slash, underTaskFolder } from "./files.js";

// 远程 Reviewer (plans/remote-reviewer.md, 2026-11-02): B looks at a remote task's 查看包 and Git Review. B's Reviewer
// windows on such a task use their own Host as always, only through /api/remote/view/<task>/… (ui: remoteViewLink);
// B's Host (`RemoteViews`) sends each read to A as rt.view and keeps the answer in its data folder, shown again while A
// is away (said to be old). On A (`answerView`) only the reads the Reviewer makes are answered, each checked:
//   - a pack must be one a session of this task sent, in the task's own project;
//   - git runs only in the task's project (the Review's target must be it), only reads, its paths inside the folder;
//   - a file's text only for files a pack of the task names or the uncommitted changes list, under the folder after
//     links and junctions are resolved, and not too big (rt.file keeps its own, wider, rules for HTML and pictures);
//   - paths in the answers name the task's folder (任务文件夹/…), never A's own (it carries the user's name).
// Comments written on B stay on B (step 3).

/** What A answers a Reviewer read of a granted task with. */
export interface ViewScope {
  host: HostService;
  task: Task;
  /** The task's folder (its project's). */
  root: string;
}

const ID = "([\\w-]{1,80})";
const ROUTES: Array<{ method: string; re: RegExp; name: "pack" | "pack-diff" | "git" | "text" | "exists" }> = [
  { method: "GET", re: new RegExp(`^/api/viewpacks/${ID}$`), name: "pack" },
  { method: "GET", re: new RegExp(`^/api/viewpacks/${ID}/items/${ID}/diff$`), name: "pack-diff" },
  { method: "GET", re: new RegExp(`^/api/workspaces/${ID}/git/(status|changes|diff|commit|commit-diff|log)$`), name: "git" },
  { method: "GET", re: /^\/api\/fs\/text$/, name: "text" },
  { method: "POST", re: /^\/api\/fs\/exists$/, name: "exists" },
];

const win = process.platform === "win32";
const fold = (p: string) => (win ? p.toLowerCase() : p);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A path under the task's folder as B reads it: `任务文件夹/a/b.md` (the folder itself: `任务文件夹`). */
const forPeer = (rel: string) => (rel ? `${REMOTE_TASK_FOLDER}/${slash(rel)}` : REMOTE_TASK_FOLDER);

/**
 * Where on A a path B gave points (`任务文件夹/…`, relative to the folder, or absolute), after links and junctions;
 * its place in the folder, or a HostError when it is not under it. `mustExist` false: a path not there (yet) is
 * checked as written — a deleted file still has a diff.
 */
export function placeInFolder(root: string, pathIn: unknown, mustExist = true): { abs: string; rel: string } | null {
  if (typeof pathIn !== "string" || !pathIn.trim() || pathIn.length > 2000 || pathIn.includes("\0")) throw new HostError("bad_request", "文件路径不对");
  const p = pathIn.trim();
  const inTask = underTaskFolder(p);
  const asked = normalize(inTask !== null ? join(root, inTask) : isAbsolute(p) ? p : join(root, p));
  const realRoot = real(root);
  if (!realRoot) throw new HostError("not_found", "任务的文件夹不在了");
  const found = real(asked);
  if (!found) {
    if (mustExist) return null;
    // Not on disk: as written, it must still stay inside (no `..` out of it).
    const r = relative(normalize(root), asked);
    if (!r || r.startsWith("..") || isAbsolute(r)) throw new HostError("read_only", "这个文件不在任务的文件夹里，不能远程查看");
    return { abs: asked, rel: slash(r) };
  }
  if (fold(found) !== fold(realRoot) && !insideFolder(found, realRoot)) throw new HostError("read_only", "这个文件不在任务的文件夹里，不能远程查看（链接或 junction 指到了外面）");
  return { abs: found, rel: slash(relative(realRoot, found)) };
}

/** The pack, if a session of this task sent it in the task's own project. */
function packOf(scope: ViewScope, packId: Id): ViewPack {
  const pack = scope.host.store.getViewPack(packId);
  const session = pack?.sessionId ? scope.host.store.getSession(pack.sessionId) : undefined;
  if (!pack || session?.taskId !== scope.task.id) throw new HostError("not_found", "这不是这个任务里的查看包");
  if (pack.workspaceId !== scope.task.workspaceId) throw new HostError("read_only", "这个查看包是别的项目的，远程只能看任务自己项目里的");
  return pack;
}

/** The files the task's packs name (relative to its project, case folded on Windows). */
function namedFiles(scope: ViewScope): Set<string> {
  const out = new Set<string>();
  const add = (p: string) => out.add(fold(slash(p).replace(/^\.\//, "")));
  for (const s of scope.host.store.listSessions({ taskId: scope.task.id })) {
    for (const pack of scope.host.store.listViewPacks(s.id, 1000)) {
      if (pack.workspaceId !== scope.task.workspaceId) continue;
      for (const it of pack.items) {
        if (it.kind === "file" || it.kind === "proposal") add(it.path);
        else {
          it.files.forEach(add);
          it.highlights.forEach((h) => add(h.path));
        }
      }
    }
  }
  return out;
}

const NOT_POINTED = "远程只能看查看包里点名的文件和改动里的文件";

/**
 * Review 2026-11-02: a file B reads (as text or as a diff) must be one somebody pointed at — in `list` (the changes of
 * the range or the commit it is read in), or, when `packsToo`, named by a pack of the task. Otherwise refused: a diff of
 * a file git ignores (`.env`, keys) or of an unchanged one is the whole file. Its entry in the list, null when only a
 * pack names it.
 */
async function pointedAt(scope: ViewScope, rel: string, list: () => Promise<readonly GitChangedFile[]>, packsToo: boolean): Promise<GitChangedFile | null> {
  const key = fold(rel);
  const hit = (await list().catch(() => [] as GitChangedFile[])).find((f) => fold(f.path) === key);
  if (hit) return hit;
  if (packsToo && namedFiles(scope).has(key)) return null;
  throw new HostError("read_only", NOT_POINTED);
}

/** `oldPath` of a diff: only the one its entry in the list gives (a rename's), as B named it. */
function oldPathOf(root: string, asked: string | null, hit: GitChangedFile | null): string | undefined {
  if (!asked) return undefined;
  const o = placeInFolder(root, asked, false)!;
  if (!hit?.oldPath || fold(hit.oldPath) !== fold(o.rel)) throw new HostError("read_only", NOT_POINTED);
  return hit.oldPath;
}

/** A GitStatus without A's folder in it. */
function scrubStatus(s: GitStatus, root: string): GitStatus {
  if (!s.root) return s;
  const r = relative(normalize(root), normalize(s.root));
  return { ...s, root: !r ? REMOTE_TASK_FOLDER : r.startsWith("..") || isAbsolute(r) ? REMOTE_TASK_FOLDER : forPeer(r) };
}

const q = (ask: RemoteViewAsk, k: string): string | null => {
  const v = ask.query?.[k];
  return typeof v === "string" ? v : null;
};

/** On A: one Reviewer read of a granted task, checked (HostError with a reason B's person can read). */
export async function answerView(scope: ViewScope, ask: RemoteViewAsk): Promise<unknown> {
  const { host, task, root } = scope;
  const path = typeof ask.path === "string" ? ask.path : "";
  const method = typeof ask.method === "string" ? ask.method.toUpperCase() : "";
  const hit = ROUTES.map((r) => ({ r, m: r.method === method ? r.re.exec(path) : null })).find((x) => x.m);
  if (!hit) throw new HostError("read_only", "远程任务的 Reviewer 只能看查看包、任务项目的改动和查看包里的文件");
  const m = hit.m!;
  switch (hit.r.name) {
    case "pack":
      return packOf(scope, m[1]!);
    case "pack-diff":
      packOf(scope, m[1]!);
      return host.viewPacks.diff(m[1]!, m[2]!);
    case "git": {
      if (m[1] !== task.workspaceId) throw new HostError("read_only", "这个 Review 不是这个任务的项目，远程只能看任务自己项目的改动");
      const ws = m[1]!;
      /** The asked file's place in the folder (a deleted one is checked as written). */
      const asked = () => placeInFolder(root, q(ask, "path"), false)!;
      switch (m[2]) {
        case "status":
          return scrubStatus(await host.gitReview.status(ws), root);
        case "changes": {
          const c: GitChanges = await host.gitReview.changes(ws, q(ask, "range"), q(ask, "base"), q(ask, "label"));
          return { ...c, status: scrubStatus(c.status, root) };
        }
        case "diff": {
          // Only a file of this range's changes, or one a pack names; whether it is untracked is the list's, not B's.
          const at = asked();
          const range = q(ask, "range");
          const base = q(ask, "base");
          const hit = await pointedAt(scope, at.rel, () => host.gitReview.changes(ws, range, range === "branch" && base ? base : undefined).then((c) => c.files), true);
          const oldPath = oldPathOf(root, q(ask, "oldPath"), hit);
          return host.gitReview.diff(ws, range, hit?.path ?? at.rel, oldPath, { base, untracked: hit ? (hit.untracked ? "1" : "0") : null });
        }
        case "commit":
          return host.gitReview.commit(ws, q(ask, "sha"), q(ask, "base"));
        case "commit-diff": {
          // Only a file the commit changed.
          const at = asked();
          const sha = q(ask, "sha");
          const base = q(ask, "base");
          const hit = await pointedAt(scope, at.rel, () => host.gitReview.commit(ws, sha, base).then((c) => c.files), false);
          return host.gitReview.commitDiff(ws, sha, base, hit!.path, oldPathOf(root, q(ask, "oldPath"), hit));
        }
        default: {
          // At most GIT_LOG_MAX commits for a remote window (the limit is otherwise the window's to choose).
          const limit = q(ask, "limit");
          const n = limit === null || limit === "" ? NaN : Number(limit);
          return host.gitReview.log(ws, Number.isFinite(n) && n > GIT_LOG_MAX ? GIT_LOG_MAX : limit);
        }
      }
    }
    case "text": {
      const ws = q(ask, "workspaceId");
      if (ws && ws !== task.workspaceId) throw new HostError("read_only", "这个文件不在这个任务的项目里");
      const at = placeInFolder(root, q(ask, "path"));
      if (!at) throw new HostError("not_found", `找不到这个文件：${slash(q(ask, "path") ?? "")}`);
      // Named by a pack, or (a Review's file) in the uncommitted changes.
      if (!namedFiles(scope).has(fold(at.rel))) await pointedAt(scope, at.rel, () => host.gitReview.changes(task.workspaceId, "working").then((c) => c.files), false);
      const info = await stat(at.abs);
      if (info.isDirectory()) throw new HostError("bad_request", "这是一个文件夹，不是文件");
      const file: TextFile = await host.openIn.readText(at.abs, null);
      return { ...file, path: forPeer(at.rel) };
    }
    case "exists": {
      const b = ask.body && typeof ask.body === "object" ? (ask.body as Record<string, unknown>) : {};
      const paths = b.paths;
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new HostError("bad_request", "paths must be a list of strings");
      if (paths.length > MAX_EXISTS_PATHS) throw new HostError("bad_request", `at most ${MAX_EXISTS_PATHS} paths at once`);
      const found: Record<string, ExistingPath | null> = {};
      await Promise.all(
        [...new Set(paths as string[])].map(async (p) => {
          let at: { abs: string; rel: string } | null = null;
          try {
            at = /^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !/^file:/i.test(p) ? null : placeInFolder(root, p);
          } catch {
            at = null;
          }
          const info = at ? await stat(at.abs).catch(() => null) : null;
          found[p] = at && info ? { path: forPeer(at.rel), dir: info.isDirectory() } : null;
        }),
      );
      return { found };
    }
  }
}

/** On A: big answers kept for their later pieces (by the asking device), a little while. */
export class ViewAnswers {
  private readonly kept = new Map<string, { owner: string; data: Buffer; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly max = REMOTE_VIEW_MAX_BYTES) {}

  /** The first piece of `value` as JSON (and the id of the rest), or a later piece of what was kept. */
  async serve(owner: string, ask: RemoteViewAsk, work: () => Promise<unknown>): Promise<RemoteViewAnswer> {
    if (ask.piece) {
      const k = this.kept.get(ask.piece.id);
      if (!k || k.owner !== owner) throw new HostError("conflict", "这一项要从头再取一次（等太久了）");
      const offset = Number.isSafeInteger(ask.piece.offset) && ask.piece.offset > 0 ? ask.piece.offset : 0;
      const data = k.data.subarray(offset, offset + REMOTE_FILE_CHUNK);
      if (offset + data.length >= k.data.length) this.forget(ask.piece.id);
      return { size: k.data.length, offset, data: data.toString("base64") };
    }
    const data = Buffer.from(JSON.stringify((await work()) ?? null));
    if (data.length > this.max) throw new HostError("bad_request", `这一项太大（${mb(data.length)}），远程最多 ${mb(this.max)}`);
    if (data.length <= REMOTE_FILE_CHUNK) return { size: data.length, offset: 0, data: data.toString("base64") };
    const id = `vw_${randomBytes(9).toString("hex")}`;
    const timer = setTimeout(() => this.kept.delete(id), 120_000);
    timer.unref?.();
    this.kept.set(id, { owner, data, timer });
    return { size: data.length, offset: 0, data: data.subarray(0, REMOTE_FILE_CHUNK).toString("base64"), id };
  }

  private forget(id: string): void {
    const k = this.kept.get(id);
    if (k) clearTimeout(k.timer);
    this.kept.delete(id);
  }
}

// ---- B: passing reads on and keeping them -------------------------------------------------------------------------

type Ask = <T>(peer: DeviceRef, kind: string, body: unknown, timeoutMs?: number, offline?: string) => Promise<T>;

const VIEW_MS = 60_000;
const GONE_PREFIX = ".gone-";

export class RemoteViews {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly ask: Ask,
  ) {}

  private get store() {
    return this.ctx.host.store;
  }

  /** remote-views/ beside remote-files/ (a temporary folder for an in-memory store). */
  root(): string {
    const db = this.store.path;
    return db === ":memory:" ? join(tmpdir(), `amo-studio-remote-views-${process.pid}`) : join(dirname(db), "remote-views");
  }

  dirOf(taskId: Id): string {
    if (!/^[\w-]{1,80}$/.test(taskId)) throw new HostError("bad_request", "任务编号不对");
    return join(this.root(), taskId);
  }

  /** What is kept of a copy's Reviewer goes with it (archived or deleted: 归档同时删除). */
  drop(taskId: Id): void {
    const dir = this.dirOf(taskId);
    if (!existsSync(dir)) return;
    const aside = join(this.root(), `${GONE_PREFIX}${taskId}-${randomBytes(4).toString("hex")}`);
    try {
      renameSync(dir, aside);
      rmSync(aside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Swept when the Host starts again.
    }
  }

  /** Folders of copies that are gone, removed when the Host starts. */
  sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.root());
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(GONE_PREFIX) && this.store.getTask(n)?.remote) continue;
      try {
        rmSync(join(this.root(), n), { recursive: true, force: true });
      } catch {
        // Next time.
      }
    }
  }

  private said(taskId: Id, stale: string | null): void {
    this.ctx.host.emit("event", { type: "remote.view", taskId, stale, seq: this.store.lastEventSeq() });
  }

  /**
   * One read of a remote task's Reviewer, from A — or, A away or the grant gone, the answer kept from last time (the
   * windows hear it is old: a remote.view event).
   */
  async read(taskId: Id, method: string, path: string, query: Record<string, string>, body: unknown): Promise<unknown> {
    const task = this.store.getTask(taskId);
    if (!task?.remote) throw new HostError("not_found", "这不是远程任务");
    const r = task.remote;
    const peer: DeviceRef = { account: r.account, device: r.device };
    const name = this.ctx.peer(peer)?.name ?? r.name;
    const sorted = Object.fromEntries(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
    const keptAt = join(this.dirOf(taskId), `${createHash("sha256").update(JSON.stringify([method, path, sorted, body ?? null])).digest("hex").slice(0, 40)}.json`);
    const kept = (stale: string): unknown => {
      const v = JSON.parse(readFileSync(keptAt, "utf8")) as unknown;
      this.said(taskId, stale);
      return v;
    };
    if (r.state !== "active") {
      if (existsSync(keptAt)) return kept("授权已收回，显示的是上次取来的内容");
      throw new HostError("read_only", "授权已收回，不能再从那台电脑看");
    }
    const ask: RemoteViewAsk = { taskId, method, path, ...(Object.keys(sorted).length ? { query: sorted } : {}), ...(body !== undefined ? { body } : {}) };
    let text: string;
    try {
      const first = await this.ask<RemoteViewAnswer>(peer, REMOTE_KINDS.view, ask, VIEW_MS, `${name} 离线，看不到（回来后再打开一次）`);
      if (first.size > REMOTE_VIEW_MAX_BYTES) throw new HostError("bad_request", `这一项太大（${mb(first.size)}），远程最多 ${mb(REMOTE_VIEW_MAX_BYTES)}`);
      const parts = [Buffer.from(first.data ?? "", "base64")];
      let got = parts[0]!.length;
      while (got < first.size) {
        if (!first.id) throw new HostError("runtime_error", "对方的回答不完整");
        const next = await this.ask<RemoteViewAnswer>(peer, REMOTE_KINDS.view, { taskId, method, path, piece: { id: first.id, offset: got } }, VIEW_MS, `${name} 离线了，没取完（回来后再打开一次）`);
        const buf = Buffer.from(next.data ?? "", "base64");
        if (!buf.length) throw new HostError("runtime_error", "没取完：对方没有再发内容");
        parts.push(buf);
        got += buf.length;
      }
      text = Buffer.concat(parts).toString("utf8");
    } catch (err) {
      // Not reachable (offline, no answer in time): what came last time, saying so.
      if (err instanceof HostError && err.code === "runtime_error" && existsSync(keptAt)) return kept(`${name} 现在连不上，显示的是上次取来的内容`);
      throw err;
    }
    const value = JSON.parse(text) as unknown;
    // Archived while it came: nothing is written back (that would bring the folder back).
    if (this.store.getTask(taskId)?.remote) {
      mkdirSync(dirname(keptAt), { recursive: true });
      writeFileSync(keptAt, text);
    }
    this.said(taskId, null);
    return value;
  }
}
