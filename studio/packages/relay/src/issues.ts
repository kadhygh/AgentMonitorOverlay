import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_FILE_BYTES } from "./protocol.js";
import { RelayError } from "./store.js";
import {
  ISSUE_BUILDS_KEPT,
  ISSUE_IMAGES_PER_ENTRY,
  ISSUE_IMAGE_TYPES,
  ISSUE_REVIEW_STATUSES,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABEL,
  ISSUE_TOOLS,
  type Issue,
  type IssueBuild,
  type IssueBuildReport,
  type IssueEntry,
  type IssueImage,
  type IssueList,
  type IssuePatch,
  type IssueRelease,
  type IssueStatus,
  type IssueViewer,
  type NewIssue,
  type NewIssueEntry,
} from "./issues-protocol.js";

// 问题页's records (2026-10-31, plans/issues.md), in the relay's database: issues numbered #1, #2…, each a list of entries
// (the report, comments, status changes — the person's and the AI's), the screenshots uploaded for them (the bytes in
// the service's files folder, like chat files), and a few values (the change counter, 发布打包's request and the last
// release). Every change takes the counter up and stamps the issue with it, so Studio asks only for what changed.
//
// 维护者 (2026-11-03, the user): every call says who asks (IssueViewer). Someone who is not a maintainer sees only their
// own issues (the list, one issue, its screenshots) and what they report waits in 待审核 until a maintainer 确认制作
// (then 新, for 值守) or 打回 with a reason (their next word hands it in again). Only maintainers write as the AI, set
// statuses and ask for or mark test builds; the AI never touches an issue waiting for review.

type Row = Record<string, unknown>;

const LIMITS = { title: 120, body: 50_000, version: 40, fixedIn: 80, worker: 200, session: 80, buildLabel: 200, buildMessage: 2000 };
const REOPENED = new Set<IssueStatus>(["fixed", "released", "stuck", "closed"]);
const IN_REVIEW = new Set<IssueStatus>(ISSUE_REVIEW_STATUSES);

function onlyMaintainers(who: IssueViewer, what: string): void {
  if (!who.maintainer) throw new RelayError("forbidden", `只有维护者能${what}`);
}

function text(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new RelayError("bad_request", `${what} 要是文字`);
  const t = value.trim();
  if (t.length > max) throw new RelayError("bad_request", `${what}太长（最多 ${max} 个字）`);
  return t;
}

function status(value: unknown): IssueStatus {
  if (!ISSUE_STATUSES.includes(value as IssueStatus)) throw new RelayError("bad_request", `没有这个状态：${String(value)}`);
  return value as IssueStatus;
}

/** The title when none is given: the report's first line, cut short. */
const titleOf = (body: string) => {
  const first = body.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
};

export class IssueStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        number INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL,
        tool TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', fixed_in TEXT NOT NULL DEFAULT '',
        worker TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issues_rev ON issues(rev);
      CREATE TABLE IF NOT EXISTS issue_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, issue INTEGER NOT NULL REFERENCES issues(number),
        author TEXT NOT NULL, ai INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_entries_issue ON issue_entries(issue, seq);
      CREATE TABLE IF NOT EXISTS issue_images (
        id TEXT PRIMARY KEY, by_name TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
        entry TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_images_entry ON issue_images(entry);
      CREATE TABLE IF NOT EXISTS issue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // 0.7.4: the Studio session that wrote on an issue last.
    const cols = (db.prepare("PRAGMA table_info(issues)").all() as Row[]).map((c) => String(c.name));
    if (!cols.includes("session")) db.exec("ALTER TABLE issues ADD COLUMN session TEXT NOT NULL DEFAULT ''");
    // 0.7.9 (维护者): who let it be worked on; the issues from before were all being worked on already.
    if (!cols.includes("approved_by")) db.exec("ALTER TABLE issues ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''; UPDATE issues SET approved_by = author;");
  }

  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = run();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM issue_meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM issue_meta WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO issue_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The change counter now. */
  rev(): number {
    return Number(this.meta("rev") ?? 0);
  }

  private bump(): number {
    const rev = this.rev() + 1;
    this.setMeta("rev", String(rev));
    return rev;
  }

  private touch(number: number): void {
    this.db.prepare("UPDATE issues SET updated_at = ?, rev = ? WHERE number = ?").run(this.now(), this.bump(), number);
  }

  /** The issue when `who` may see it: a maintainer any, anyone else their own (another's is as good as missing). */
  private row(number: number, who: IssueViewer): Row {
    const row = this.db.prepare("SELECT * FROM issues WHERE number = ?").get(number) as Row | undefined;
    if (!row || (!who.maintainer && row.author !== who.name)) throw new RelayError("not_found", `没有问题 #${number}`);
    return row;
  }

  private view(row: Row, entries = false): Issue {
    const number = Number(row.number);
    const last = this.db.prepare("SELECT ai FROM issue_entries WHERE issue = ? AND kind != 'status' ORDER BY seq DESC LIMIT 1").get(number) as Row | undefined;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM issue_entries WHERE issue = ?").get(number) as Row;
    const st = String(row.status) as IssueStatus;
    const issue: Issue = {
      number,
      title: String(row.title),
      author: String(row.author),
      status: st,
      tool: String(row.tool),
      version: String(row.version),
      fixedIn: String(row.fixed_in),
      approvedBy: String(row.approved_by ?? ""),
      worker: String(row.worker),
      session: String(row.session ?? ""),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      rev: Number(row.rev),
      entryCount: Number(count.n),
      awaitsAi: !!last && !Number(last.ai) && st !== "closed" && st !== "released" && !IN_REVIEW.has(st),
    };
    if (entries) issue.entries = this.entries(number);
    return issue;
  }

  private entries(number: number): IssueEntry[] {
    const rows = this.db.prepare("SELECT * FROM issue_entries WHERE issue = ? ORDER BY seq").all(number) as Row[];
    const images = this.db.prepare("SELECT * FROM issue_images WHERE entry IN (SELECT id FROM issue_entries WHERE issue = ?) ORDER BY created_at, id").all(number) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      seq: Number(r.seq),
      author: String(r.author),
      ai: !!Number(r.ai),
      kind: String(r.kind) as IssueEntry["kind"],
      body: String(r.body),
      images: images.filter((i) => i.entry === r.id).map(imageView),
      status: r.status ? (String(r.status) as IssueStatus) : null,
      at: Number(r.created_at),
    }));
  }

  /** The issues changed after `after` (every one without it), newest first, and 发布打包's state. */
  list(who: IssueViewer, after?: number): IssueList {
    const mine = who.maintainer ? "" : " AND author = ?";
    const args = [after ?? 0, ...(who.maintainer ? [] : [who.name])];
    const rows = this.db.prepare(`SELECT * FROM issues WHERE rev > ?${mine} ORDER BY number DESC`).all(...args) as Row[];
    return { issues: rows.map((r) => this.view(r)), release: this.release(), rev: this.rev(), me: { name: who.name, maintainer: who.maintainer } };
  }

  get(who: IssueViewer, number: number): Issue {
    return this.view(this.row(number, who), true);
  }

  /** A screenshot uploaded before the issue or comment that carries it (the bytes are the service's to keep). */
  addImage(by: string, input: { id: string; name: unknown; type: unknown; size: number }): IssueImage {
    const type = typeof input.type === "string" ? input.type.split(";")[0]!.trim().toLowerCase() : "";
    if (!(ISSUE_IMAGE_TYPES as readonly string[]).includes(type)) throw new RelayError("bad_request", "只能传图片（PNG、JPEG、GIF、WebP）");
    if (input.size > MAX_FILE_BYTES) throw new RelayError("bad_request", `图片太大（最多 ${MAX_FILE_BYTES / 1024 / 1024} MB）`);
    const name = text(input.name, "文件名", 200) || `截图.${type.split("/")[1]}`;
    this.db.prepare("INSERT INTO issue_images (id, by_name, name, type, size, entry, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)").run(input.id, by, name, type, input.size, this.now());
    return { id: input.id, name, type, size: input.size };
  }

  /**
   * Screenshots uploaded but never put on an issue or comment (pasted, then the report was not sent), older than `age`
   * ms: their rows go, and their ids come back for the service to delete the bytes (2026-11-04, the 11-03 audit: they
   * stayed on the team server for good).
   */
  pruneOrphanImages(age: number): string[] {
    const before = this.now() - age;
    const ids = (this.db.prepare("SELECT id FROM issue_images WHERE entry IS NULL AND created_at < ?").all(before) as Row[]).map((r) => String(r.id));
    if (ids.length) this.db.prepare("DELETE FROM issue_images WHERE entry IS NULL AND created_at < ?").run(before);
    return ids;
  }

  /** A screenshot, for who uploaded it or may see the issue it is on. */
  image(who: IssueViewer, id: string): IssueImage {
    const row = this.db.prepare("SELECT i.*, x.author AS issue_author FROM issue_images i LEFT JOIN issue_entries e ON e.id = i.entry LEFT JOIN issues x ON x.number = e.issue WHERE i.id = ?").get(id) as Row | undefined;
    const mine = !!row && (row.by_name === who.name || row.issue_author === who.name);
    if (!row || (!who.maintainer && !mine)) throw new RelayError("not_found", "没有这张图");
    return imageView(row);
  }

  private attach(by: string, entry: string, ids: unknown): void {
    if (ids === undefined || ids === null) return;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new RelayError("bad_request", "images 要是图片 id 的列表");
    if (ids.length > ISSUE_IMAGES_PER_ENTRY) throw new RelayError("bad_request", `一次最多 ${ISSUE_IMAGES_PER_ENTRY} 张图`);
    for (const id of ids as string[]) {
      const row = this.db.prepare("SELECT by_name, entry FROM issue_images WHERE id = ?").get(id) as Row | undefined;
      if (!row || row.by_name !== by) throw new RelayError("bad_request", "有一张图没有传上来，重新粘贴一次");
      if (row.entry) throw new RelayError("bad_request", "有一张图已经用过了");
      this.db.prepare("UPDATE issue_images SET entry = ? WHERE id = ?").run(entry, id);
    }
  }

  private addEntryRow(number: number, by: string, kind: IssueEntry["kind"], body: string, ai: boolean, st: IssueStatus | null, images: unknown): void {
    const id = `ie_${randomBytes(8).toString("hex")}`;
    this.db.prepare("INSERT INTO issue_entries (id, issue, author, ai, kind, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, number, by, ai ? 1 : 0, kind, body, st, this.now());
    this.attach(by, id, images);
  }

  /** A maintainer's report is 新 at once; anyone else's waits for review (待审核). */
  create(who: IssueViewer, input: NewIssue): Issue {
    const by = who.name;
    const body = text(input.body, "问题描述", LIMITS.body);
    const pictures = Array.isArray(input.images) ? input.images.length : 0;
    if (!body && !pictures) throw new RelayError("bad_request", "写一句话或贴一张截图");
    const title = text(input.title, "标题", LIMITS.title) || titleOf(body) || "（截图）";
    const tool = text(input.tool, "工具", 20);
    if (tool && !ISSUE_TOOLS[tool]) throw new RelayError("bad_request", `没有这个工具：${tool}`);
    const version = text(input.version, "版本", LIMITS.version);
    return this.tx(() => {
      const at = this.now();
      const r = this.db
        .prepare("INSERT INTO issues (title, author, status, approved_by, tool, version, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(title, by, who.maintainer ? "new" : "review", who.maintainer ? by : "", tool, version, at, at, this.bump());
      const number = Number(r.lastInsertRowid);
      this.addEntryRow(number, by, "report", body, false, null, input.images);
      return this.get(who, number);
    });
  }

  /** What the AI (值守, a maintainer's account) may not do: write before a maintainer let the issue be worked on. */
  private aiAllowed(who: IssueViewer, row: Row): void {
    onlyMaintainers(who, "代 AI 回复");
    if (IN_REVIEW.has(String(row.status) as IssueStatus)) throw new RelayError("forbidden", `问题 #${String(row.number)} 还在等维护者审核，AI 先不处理`);
  }

  /**
   * The status a word from `who` (not the AI) moves the issue to, if any: on an issue that was put away (修好 / 已发布 /
   * 卡住 / 不修了) it opens it again — 「还不对」 is something to work on — and its author's word on 打回 hands it in
   * again. One never let through waits for review again, unless a maintainer writes.
   */
  private reopenedBy(who: IssueViewer, row: Row): IssueStatus | null {
    const st = String(row.status) as IssueStatus;
    if (st === "rejected") return row.author === who.name ? (who.maintainer ? "new" : "review") : null;
    const approved = !!String(row.approved_by ?? "") || who.maintainer;
    return REOPENED.has(st) ? (approved ? "new" : "review") : null;
  }

  /** Sets the status (a maintainer moving it out of review lets it be worked on: approved_by). */
  private setStatus(who: IssueViewer, row: Row, st: IssueStatus): void {
    const number = Number(row.number);
    this.db.prepare("UPDATE issues SET status = ? WHERE number = ?").run(st, number);
    if (who.maintainer && !IN_REVIEW.has(st) && st !== "closed" && !String(row.approved_by ?? "")) this.db.prepare("UPDATE issues SET approved_by = ? WHERE number = ?").run(who.name, number);
  }

  /** Checks a status asked for with a comment: maintainers only, and 打回 says why. */
  private statusAsked(who: IssueViewer, value: unknown, body: string, ai: boolean): IssueStatus {
    const st = status(value);
    onlyMaintainers(who, "改问题的状态");
    if (ai && IN_REVIEW.has(st)) throw new RelayError("forbidden", "「待审核」「打回」只由维护者在问题页上点");
    if (st === "rejected" && !body) throw new RelayError("bad_request", "打回要写一句原因");
    return st;
  }

  /**
   * A comment (the person's, or the AI's with `ai`), optionally changing the status with it (maintainers); a word on an
   * issue put away or sent back moves it on (reopenedBy).
   */
  addEntry(who: IssueViewer, number: number, input: NewIssueEntry): Issue {
    const row = this.row(number, who);
    const ai = input.ai === true;
    if (ai) this.aiAllowed(who, row);
    const body = text(input.body, "内容", LIMITS.body);
    const st = input.status === undefined ? (ai ? null : this.reopenedBy(who, row)) : this.statusAsked(who, input.status, body, ai);
    const pictures = Array.isArray(input.images) ? input.images.length : 0;
    if (!body && !pictures && !st) throw new RelayError("bad_request", "写一句话或贴一张截图");
    const session = ai ? text(input.session, "会话", LIMITS.session) : "";
    return this.tx(() => {
      this.addEntryRow(number, who.name, body || pictures ? "comment" : "status", body, ai, st, input.images);
      if (st) this.setStatus(who, row, st);
      if (session) this.db.prepare("UPDATE issues SET session = ? WHERE number = ?").run(session, number);
      this.touch(number);
      return this.get(who, number);
    });
  }

  /**
   * Status, title, the build it went out in, who works on it. A status change is an entry of its own. Someone who is
   * not a maintainer may retitle their own issue, put it away (不修了) and open it again (back to review when it was
   * never let through); the rest is maintainers'. 打回 needs a reason, so it goes with a comment (addEntry).
   */
  update(who: IssueViewer, number: number, patch: IssuePatch & { ai?: boolean }): Issue {
    const by = who.name;
    const row = this.row(number, who);
    if (patch.ai === true) this.aiAllowed(who, row);
    if (patch.fixedIn !== undefined || patch.worker !== undefined || patch.session) onlyMaintainers(who, "改处理者、会话和发布版本");
    let asked: IssueStatus | undefined;
    if (patch.status !== undefined) {
      asked = status(patch.status);
      if (asked === "rejected") throw new RelayError("bad_request", "打回要写一句原因：写在回复里再点「打回」");
      if (asked === "review" && patch.ai === true) throw new RelayError("forbidden", "「待审核」「打回」只由维护者在问题页上点");
      if (!who.maintainer) {
        if (asked !== "closed" && asked !== "new") onlyMaintainers(who, "改问题的状态");
        // 重新打开 by its author: back to review unless it was let through before.
        if (asked === "new") asked = this.reopenedBy(who, { ...row, status: row.status === "rejected" ? "rejected" : "closed" }) ?? undefined;
      }
    }
    return this.tx(() => {
      if (patch.title !== undefined) {
        const title = text(patch.title, "标题", LIMITS.title);
        if (!title) throw new RelayError("bad_request", "标题不能为空");
        this.db.prepare("UPDATE issues SET title = ? WHERE number = ?").run(title, number);
      }
      if (patch.fixedIn !== undefined) this.db.prepare("UPDATE issues SET fixed_in = ? WHERE number = ?").run(text(patch.fixedIn, "发布版本", LIMITS.fixedIn), number);
      if (patch.worker !== undefined) this.db.prepare("UPDATE issues SET worker = ? WHERE number = ?").run(text(patch.worker, "处理者", LIMITS.worker), number);
      if (patch.session && patch.ai === true) this.db.prepare("UPDATE issues SET session = ? WHERE number = ?").run(text(patch.session, "会话", LIMITS.session), number);
      if (asked !== undefined && asked !== row.status) {
        this.setStatus(who, row, asked);
        this.addEntryRow(number, by, "status", `状态改为「${ISSUE_STATUS_LABEL[asked]}」`, patch.ai === true, asked, undefined);
      }
      this.touch(number);
      return this.get(who, number);
    });
  }

  release(): IssueRelease {
    const at = this.meta("release.requestedAt");
    const last = this.meta("release.last");
    const builds = this.builds();
    return { requestedAt: at ? Number(at) : null, requestedBy: this.meta("release.requestedBy") ?? "", last: last ? (JSON.parse(last) as IssueRelease["last"]) : null, build: builds[0] ?? null, builds };
  }

  /** The kept builds, newest first (0.7.3 kept only the last, without its steps' times). */
  private builds(): IssueBuild[] {
    const all = this.meta("release.builds");
    const one = this.meta("release.build");
    const list = (all ? JSON.parse(all) : one ? [JSON.parse(one)] : []) as IssueBuild[];
    return list.map((b) => ({ ...b, stepAt: Array.isArray(b.stepAt) && b.stepAt.length ? b.stepAt : [b.startedAt] }));
  }

  /** `npm run release` says where its test build is (2026-10-31): started, at a step, ended. */
  reportBuild(by: string, report: IssueBuildReport): IssueRelease {
    const r = (report && typeof report === "object" ? report : {}) as IssueBuildReport;
    const now = this.now();
    const builds = this.builds();
    const current = builds[0];
    let next: IssueBuild;
    if (r.start) {
      const label = text(r.start.label, "打包的内容", LIMITS.buildLabel);
      const steps = Array.isArray(r.start.steps) ? r.start.steps.map((s) => text(s, "步骤", 40)).filter(Boolean) : [];
      if (!label || !steps.length || steps.length > 12) throw new RelayError("bad_request", "要写打包的内容和 1 到 12 个步骤");
      // One that never said it ended (the machine went off): ended where it was, so it is not shown as going on.
      if (current && current.endedAt === null) builds[0] = { ...current, endedAt: current.updatedAt, ok: false, message: "没有报结束（被打断了？）" };
      next = { label, steps, step: 0, stepAt: [now], by, startedAt: now, updatedAt: now, endedAt: null, ok: null, message: "" };
      builds.unshift(next);
    } else {
      if (!current || current.endedAt !== null) throw new RelayError("conflict", "现在没有在打包");
      next = { ...current, stepAt: [...current.stepAt], updatedAt: now };
      builds[0] = next;
    }
    if (r.step !== undefined) {
      if (!Number.isInteger(r.step) || r.step < next.step || r.step >= next.steps.length) throw new RelayError("bad_request", `步骤要在 ${next.step} 到 ${next.steps.length - 1} 之间`);
      // A step skipped on the way began (and ended) at once.
      for (let k = next.step + 1; k <= r.step; k++) next.stepAt[k] = now;
      next.step = r.step;
    }
    if (r.end) {
      next.endedAt = now;
      next.ok = r.end.ok === true;
      next.message = text(r.end.message, "结果", LIMITS.buildMessage);
    }
    this.tx(() => {
      this.setMeta("release.builds", JSON.stringify(builds.slice(0, ISSUE_BUILDS_KEPT)));
      this.setMeta("release.build", null);
      this.bump();
    });
    return this.release();
  }

  /** 发布打包 clicked: kept until Studio says the build is out (or the person takes it back). */
  requestRelease(who: IssueViewer, on = true): IssueRelease {
    onlyMaintainers(who, "请求发布打包");
    const by = who.name;
    this.tx(() => {
      this.setMeta("release.requestedAt", on ? String(this.now()) : null);
      this.setMeta("release.requestedBy", on ? by : null);
      this.bump();
    });
    return this.release();
  }

  /** Studio published a test build: the request is done, and the issues it fixed are 已发布 in it. */
  released(who: IssueViewer, version: unknown, numbers: unknown): IssueList {
    onlyMaintainers(who, "标记已发布");
    const by = who.name;
    const v = text(version, "版本", LIMITS.fixedIn);
    if (!v) throw new RelayError("bad_request", "要写发布的版本");
    const list = Array.isArray(numbers) ? numbers.filter((n): n is number => Number.isInteger(n)) : [];
    this.tx(() => {
      this.setMeta("release.requestedAt", null);
      this.setMeta("release.requestedBy", null);
      this.setMeta("release.last", JSON.stringify({ version: v, at: this.now() }));
      for (const n of list) {
        const row = this.db.prepare("SELECT status FROM issues WHERE number = ?").get(n) as Row | undefined;
        if (!row) continue;
        this.db.prepare("UPDATE issues SET status = 'released', fixed_in = ? WHERE number = ?").run(v, n);
        this.addEntryRow(n, by, "status", `已发布在测试版 ${v}：更新后试一下，还不对就在这里接着说`, true, "released", undefined);
        this.touch(n);
      }
      this.bump();
    });
    return this.list(who);
  }
}

function imageView(r: Row): IssueImage {
  return { id: String(r.id), name: String(r.name), type: String(r.type), size: Number(r.size) };
}
