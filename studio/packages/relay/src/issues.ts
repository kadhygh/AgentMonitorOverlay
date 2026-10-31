import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_FILE_BYTES } from "./protocol.js";
import { RelayError } from "./store.js";
import {
  ISSUE_IMAGES_PER_ENTRY,
  ISSUE_IMAGE_TYPES,
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
  type NewIssue,
  type NewIssueEntry,
} from "./issues-protocol.js";

// 问题页's records (2026-10-31, plans/issues.md), in the relay's database: issues numbered #1, #2…, each a list of entries
// (the report, comments, status changes — the person's and the AI's), the screenshots uploaded for them (the bytes in
// the service's files folder, like chat files), and a few values (the change counter, 发布打包's request and the last
// release). Every change takes the counter up and stamps the issue with it, so Studio asks only for what changed.

type Row = Record<string, unknown>;

const LIMITS = { title: 120, body: 50_000, version: 40, fixedIn: 80, worker: 200, buildLabel: 200, buildMessage: 2000 };
const REOPENED = new Set<IssueStatus>(["fixed", "released", "stuck", "closed"]);

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

  private row(number: number): Row {
    const row = this.db.prepare("SELECT * FROM issues WHERE number = ?").get(number) as Row | undefined;
    if (!row) throw new RelayError("not_found", `没有问题 #${number}`);
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
      worker: String(row.worker),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      rev: Number(row.rev),
      entryCount: Number(count.n),
      awaitsAi: !!last && !Number(last.ai) && st !== "closed" && st !== "released",
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
  list(after?: number): IssueList {
    const rows = (after ? this.db.prepare("SELECT * FROM issues WHERE rev > ? ORDER BY number DESC").all(after) : this.db.prepare("SELECT * FROM issues ORDER BY number DESC").all()) as Row[];
    return { issues: rows.map((r) => this.view(r)), release: this.release(), rev: this.rev() };
  }

  get(number: number): Issue {
    return this.view(this.row(number), true);
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

  image(id: string): IssueImage {
    const row = this.db.prepare("SELECT * FROM issue_images WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RelayError("not_found", "没有这张图");
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

  create(by: string, input: NewIssue): Issue {
    const body = text(input.body, "问题描述", LIMITS.body);
    const pictures = Array.isArray(input.images) ? input.images.length : 0;
    if (!body && !pictures) throw new RelayError("bad_request", "写一句话或贴一张截图");
    const title = text(input.title, "标题", LIMITS.title) || titleOf(body) || "（截图）";
    const tool = text(input.tool, "工具", 20);
    if (tool && !ISSUE_TOOLS[tool]) throw new RelayError("bad_request", `没有这个工具：${tool}`);
    const version = text(input.version, "版本", LIMITS.version);
    return this.tx(() => {
      const at = this.now();
      const r = this.db.prepare("INSERT INTO issues (title, author, status, tool, version, created_at, updated_at, rev) VALUES (?, ?, 'new', ?, ?, ?, ?, ?)").run(title, by, tool, version, at, at, this.bump());
      const number = Number(r.lastInsertRowid);
      this.addEntryRow(number, by, "report", body, false, null, input.images);
      return this.get(number);
    });
  }

  /**
   * A comment (the person's, or the AI's with `ai`), optionally changing the status with it. The person writing on an
   * issue that was put away (修好 / 已发布 / 卡住 / 不修了) opens it again: 「还不对」 is something to work on.
   */
  addEntry(by: string, number: number, input: NewIssueEntry): Issue {
    const row = this.row(number);
    const body = text(input.body, "内容", LIMITS.body);
    const reopen = input.ai !== true && input.status === undefined && REOPENED.has(String(row.status) as IssueStatus);
    const st = input.status === undefined ? (reopen ? "new" : null) : status(input.status);
    const pictures = Array.isArray(input.images) ? input.images.length : 0;
    if (!body && !pictures && !st) throw new RelayError("bad_request", "写一句话或贴一张截图");
    return this.tx(() => {
      this.addEntryRow(number, by, body || pictures ? "comment" : "status", body, input.ai === true, st, input.images);
      if (st) this.db.prepare("UPDATE issues SET status = ? WHERE number = ?").run(st, number);
      this.touch(number);
      return this.get(number);
    });
  }

  /** Status, title, the build it went out in, who works on it. A status change is an entry of its own. */
  update(by: string, number: number, patch: IssuePatch & { ai?: boolean }): Issue {
    const row = this.row(number);
    return this.tx(() => {
      if (patch.title !== undefined) {
        const title = text(patch.title, "标题", LIMITS.title);
        if (!title) throw new RelayError("bad_request", "标题不能为空");
        this.db.prepare("UPDATE issues SET title = ? WHERE number = ?").run(title, number);
      }
      if (patch.fixedIn !== undefined) this.db.prepare("UPDATE issues SET fixed_in = ? WHERE number = ?").run(text(patch.fixedIn, "发布版本", LIMITS.fixedIn), number);
      if (patch.worker !== undefined) this.db.prepare("UPDATE issues SET worker = ? WHERE number = ?").run(text(patch.worker, "处理者", LIMITS.worker), number);
      if (patch.status !== undefined) {
        const st = status(patch.status);
        if (st !== row.status) {
          this.db.prepare("UPDATE issues SET status = ? WHERE number = ?").run(st, number);
          this.addEntryRow(number, by, "status", `状态改为「${ISSUE_STATUS_LABEL[st]}」`, patch.ai === true, st, undefined);
        }
      }
      this.touch(number);
      return this.get(number);
    });
  }

  release(): IssueRelease {
    const at = this.meta("release.requestedAt");
    const last = this.meta("release.last");
    const build = this.meta("release.build");
    return { requestedAt: at ? Number(at) : null, requestedBy: this.meta("release.requestedBy") ?? "", last: last ? (JSON.parse(last) as IssueRelease["last"]) : null, build: build ? (JSON.parse(build) as IssueBuild) : null };
  }

  /** `npm run release` says where its test build is (2026-10-31): started, at a step, ended. */
  reportBuild(by: string, report: IssueBuildReport): IssueRelease {
    const r = (report && typeof report === "object" ? report : {}) as IssueBuildReport;
    const now = this.now();
    const current = this.release().build;
    let next: IssueBuild;
    if (r.start) {
      const label = text(r.start.label, "打包的内容", LIMITS.buildLabel);
      const steps = Array.isArray(r.start.steps) ? r.start.steps.map((s) => text(s, "步骤", 40)).filter(Boolean) : [];
      if (!label || !steps.length || steps.length > 12) throw new RelayError("bad_request", "要写打包的内容和 1 到 12 个步骤");
      next = { label, steps, step: 0, by, startedAt: now, updatedAt: now, endedAt: null, ok: null, message: "" };
    } else {
      if (!current || current.endedAt !== null) throw new RelayError("conflict", "现在没有在打包");
      next = { ...current, updatedAt: now };
    }
    if (r.step !== undefined) {
      if (!Number.isInteger(r.step) || r.step < 0 || r.step >= next.steps.length) throw new RelayError("bad_request", `步骤要在 0 到 ${next.steps.length - 1} 之间`);
      next.step = r.step;
    }
    if (r.end) {
      next.endedAt = now;
      next.ok = r.end.ok === true;
      next.message = text(r.end.message, "结果", LIMITS.buildMessage);
    }
    this.tx(() => {
      this.setMeta("release.build", JSON.stringify(next));
      this.bump();
    });
    return this.release();
  }

  /** 发布打包 clicked: kept until Studio says the build is out (or the person takes it back). */
  requestRelease(by: string, on = true): IssueRelease {
    this.tx(() => {
      this.setMeta("release.requestedAt", on ? String(this.now()) : null);
      this.setMeta("release.requestedBy", on ? by : null);
      this.bump();
    });
    return this.release();
  }

  /** Studio published a test build: the request is done, and the issues it fixed are 已发布 in it. */
  released(by: string, version: unknown, numbers: unknown): IssueList {
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
    return this.list();
  }
}

function imageView(r: Row): IssueImage {
  return { id: String(r.id), name: String(r.name), type: String(r.type), size: Number(r.size) };
}
