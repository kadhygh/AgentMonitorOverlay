import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { ISSUE_IMAGES_PER_ENTRY, ISSUE_STATUS_LABEL, ISSUE_STATUSES, RelayClient, RelayClientError, type Issue, type IssueList, type IssuePatch, type IssueStatus } from "@amo-studio/relay/light";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import type { Id } from "@amo-studio/protocol";
import type { DutyCheckJob, DutyFinding } from "../duty/service.js";

// 问题页 ↔ 会话 (2026-10-31, plans/issues.md stage 3): a session reads the issues the person reported on the team
// server's /issues page and answers them — as the person (the platform's login, like 中转), each entry marked as the
// AI's. No built-in job: the person starts a 值守 item whose prompt names the prompt template that says how to work
// the issues (the user, 2026-10-31), and the session uses these tools; the item checks the page first (dutyCheck, in
// code), so a model starts only when there is something to do. Screenshots are fetched into the data folder so the
// agent can open them.

export const ISSUES_NOT_SIGNED_IN = "要先在 AMO 平台里登录团队服务器，才能读写问题页。";
const IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
/** Statuses an issue is still open in (for 值守's list). */
const OPEN = new Set<IssueStatus>(["new", "working", "asking", "fixed", "stuck", "discuss"]);

export interface IssueLine {
  number: number;
  title: string;
  status: IssueStatus;
  statusLabel: string;
  tool: string;
  version: string;
  worker: string;
  /** The Studio session that wrote on it last; "". */
  session: string;
  fixedIn: string;
  /** The person wrote last: something to read and answer. */
  awaitsAi: boolean;
  updatedAt: string;
}

/** Per issue, the session that wrote on it last. */
const SESSIONS_KEY = "issues.sessions";
const SESSIONS_KEPT = 300;
/** A 值守 session's name: "#<编号> " and this much of the issue's title. */
const TITLE_MAX = 30;

export class IssuesFeature extends Feature {
  /**
   * 值守's check 「问题页」 (2026-10-31): what there is to do on the page, in code, so a model starts only then — new
   * issues, the person's answers, and a test build that did not go through. The lines carry no times, so the same
   * state reads the same and 值守 does not start a second session for it. 2026-11-01 (the user: 打包真的有必要跑个
   * agent么): test builds go out by themselves (值守 item 自动打包, `release.mjs auto --if-due`); a model is started
   * only when one failed.
   */
  dutyCheck(): DutyCheckJob {
    return {
      name: "issues.pending",
      label: "问题页有事要做",
      description: "有新问题、你在问题下回复了，或者上一次打测试包没成功",
      run: () => this.pendingWork(),
    };
  }

  async pending(): Promise<string | null> {
    return (await this.pendingWork())?.text ?? null;
  }

  /**
   * What there is to do, the session's name, and — when it is only the person's answers on issues one session took —
   * that session, for 值守 to go on in (问题 #1's follow-up, the user, 2026-10-31: an answer started a new session
   * instead of the one that asked; each 值守 session named "#<编号> <一句话>").
   */
  async pendingWork(): Promise<DutyFinding | null> {
    const { issues, release } = await this.call((c) => c.issues());
    const lines: string[] = [];
    const fresh = issues.filter((i) => i.status === "new").sort((a, b) => a.number - b.number);
    if (fresh.length) lines.push(`新问题：${fresh.map((i) => `#${i.number} ${i.title}`).join("；")}`);
    // 去会话讨论 is the person's own, answers on it included (2026-10-31 晚): not 值守's.
    const answered = issues.filter((i) => i.awaitsAi && (i.status === "asking" || i.status === "working" || i.status === "stuck")).sort((a, b) => a.number - b.number);
    if (answered.length) lines.push(`你回复了：${answered.map((i) => `#${i.number} ${i.title}（${ISSUE_STATUS_LABEL[i.status]}，第 ${i.entryCount} 条）`).join("；")}`);
    // The last test build stopped (its step and message are on the page); a newer one going through clears it.
    const build = release.build;
    const failed = build && build.endedAt !== null && build.ok === false ? `${build.label}${build.steps[build.step] ? `，停在「${build.steps[build.step]}」` : ""}：${build.message}` : null;
    if (failed) lines.push(`上一次打测试包没成功（${failed}）`);
    if (!lines.length) return null;
    // The template takes answered ones first, then new ones: the session is named after the first it will take.
    const first = answered[0] ?? fresh[0];
    const title = first ? `#${first.number} ${oneLine(first.title)}` : "打包没成功";
    const known = this.sessions();
    const took = new Set(answered.map((i) => known[i.number]));
    const sessionId = answered.length && !fresh.length && !failed && took.size === 1 ? [...took][0] : undefined;
    return { text: lines.join("\n"), title, ...(sessionId ? { sessionId } : {}) };
  }

  /** Per issue, the session that wrote on it last (kept in Studio: the page does not know Studio's sessions). */
  private sessions(): Record<number, Id> {
    try {
      return JSON.parse(this.store.getKv(SESSIONS_KEY)?.value ?? "{}") as Record<number, Id>;
    } catch {
      return {};
    }
  }

  private wroteOn(number: number, sessionId: Id | undefined): void {
    if (!sessionId || !this.store.getSession(sessionId)) return;
    const all = this.sessions();
    delete all[number];
    // Insertion order: the oldest go first.
    const kept = Object.entries({ ...all, [number]: sessionId }).slice(-SESSIONS_KEPT);
    this.store.setKv(SESSIONS_KEY, JSON.stringify(Object.fromEntries(kept)));
  }

  private client(): RelayClient {
    const login = this.teamLink.login();
    if (!login) throw new HostError("bad_request", ISSUES_NOT_SIGNED_IN);
    return new RelayClient(login.account.server, login.account.key);
  }

  /** A team-server call; its refusals and an unreachable server become errors the agent can read. */
  private async call<T>(run: (c: RelayClient) => Promise<T>): Promise<T> {
    const c = this.client();
    try {
      return await run(c);
    } catch (err) {
      if (err instanceof RelayClientError) throw new HostError(err.status === 404 ? "not_found" : "bad_request", err.message);
      throw new HostError("runtime_error", `连不上团队服务器：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The open issues (or all), newest change first, and where 发布打包 stands. */
  async list(all = false): Promise<{ release: IssueList["release"]; issues: IssueLine[] }> {
    const out = await this.call((c) => c.issues());
    const issues = out.issues
      .filter((i) => all || OPEN.has(i.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((i) => ({ number: i.number, title: i.title, status: i.status, statusLabel: ISSUE_STATUS_LABEL[i.status], tool: i.tool, version: i.version, worker: i.worker, session: i.session ?? "", fixedIn: i.fixedIn, awaitsAi: i.awaitsAi, updatedAt: new Date(i.updatedAt).toISOString() }));
    return { release: out.release, issues };
  }

  /** One issue with its whole conversation; each screenshot as a local file the agent can open. */
  async get(number: number): Promise<Issue & { entries: Array<NonNullable<Issue["entries"]>[number] & { images: Array<{ id: string; name: string; type: string; size: number; path?: string; error?: string }> }> }> {
    return this.call(async (c) => {
      const issue = await c.issue(number);
      const entries = await Promise.all(
        (issue.entries ?? []).map(async (e) => ({
          ...e,
          images: await Promise.all(
            e.images.map(async (im) => {
              try {
                return { ...im, path: await this.imageFile(c, im.id, im.type) };
              } catch (err) {
                return { ...im, error: err instanceof Error ? err.message : String(err) };
              }
            }),
          ),
        })),
      );
      return { ...issue, entries };
    });
  }

  /** issue-images/ beside the database (a temporary folder for an in-memory store); fetched once. */
  private async imageFile(c: RelayClient, id: string, type: string): Promise<string> {
    if (!/^ii_[0-9a-f]{16}$/.test(id)) throw new Error("图片编号不对");
    const db = this.store.path;
    const dir = db === ":memory:" ? join(tmpdir(), `amo-studio-issue-images-${process.pid}`) : join(dirname(db), "issue-images");
    const at = join(dir, `${id}${EXT[type] ?? ".png"}`);
    if (existsSync(at)) return at;
    const data = await c.issueImageData(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(at, data);
    return at;
  }

  /** A word on the issue as the AI, with screenshots from this computer, optionally changing its status. */
  async reply(number: number, input: { body?: string; status?: string; images?: unknown }, sessionId?: Id): Promise<Issue> {
    const files = localImages(input.images);
    const st = input.status === undefined ? undefined : issueStatus(input.status);
    // Which session wrote, on the issue too: the person copies it from the page to find the session (2026-10-31 晚).
    const session = sessionId ? { session: sessionId } : {};
    const out = await this.call(async (c) => {
      const ids: string[] = [];
      for (const f of files) ids.push((await c.uploadIssueImage(basename(f), readFileSync(f), IMAGE_TYPES[extname(f).toLowerCase()]!)).id);
      return c.addIssueEntry(number, { body: input.body ?? "", images: ids, ai: true, ...(st ? { status: st } : {}), ...session });
    });
    this.wroteOn(number, sessionId);
    return out;
  }

  /** Status, title, who works on it, the build it went out in — each marked as the AI's. */
  async update(number: number, patch: { status?: string; title?: string; worker?: string; fixedIn?: string }, sessionId?: Id): Promise<Issue> {
    const p: IssuePatch = {};
    if (patch.status !== undefined) p.status = issueStatus(patch.status);
    if (patch.title !== undefined) p.title = patch.title;
    if (patch.worker !== undefined) p.worker = patch.worker;
    if (patch.fixedIn !== undefined) p.fixedIn = patch.fixedIn;
    if (!Object.keys(p).length) throw new HostError("bad_request", "没有要改的（status、title、worker、fixedIn）");
    const out = await this.call((c) => c.updateIssue(number, { ...p, ai: true, ...(sessionId ? { session: sessionId } : {}) }));
    this.wroteOn(number, sessionId);
    return out;
  }

  /** A test build went out: the issues it fixed become 已发布 with that version, and 发布打包's request is done. */
  async released(version: string, numbers: number[]): Promise<{ release: IssueList["release"]; released: number[] }> {
    if (!version.trim()) throw new HostError("bad_request", "要写发布的版本（例如 Studio 0.9.17）");
    const out = await this.call((c) => c.issueReleased(version.trim(), numbers));
    return { release: out.release, released: numbers.filter((n) => out.issues.some((i) => i.number === n && i.status === "released")) };
  }
}

/** An issue's title as a session's name: one line, not too long. */
function oneLine(title: string): string {
  const t = title.replace(/\s+/g, " ").trim() || "（没写标题）";
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function issueStatus(value: string): IssueStatus {
  if (!(ISSUE_STATUSES as readonly string[]).includes(value)) throw new HostError("bad_request", `状态只能是 ${ISSUE_STATUSES.join("、")}`);
  // The person's only (前往讨论, 2026-10-31 晚): a big or unclear one is asking, with how the AI would go.
  if (value === "discuss") throw new HostError("bad_request", "「去会话讨论」只由人在问题页上点。要人拍板就写清楚你的想法，状态用 asking（需要确认）。");
  // 维护者 (2026-11-03): 待审核 and 打回 are a maintainer's, on the page; the AI works only on what was let through.
  if (value === "review" || value === "rejected") throw new HostError("bad_request", "「待审核」「打回」只由维护者在问题页上点；这两种状态的问题 AI 不处理。");
  return value as IssueStatus;
}

function localImages(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((f) => typeof f !== "string")) throw new HostError("bad_request", "images 是图片的完整路径列表");
  const files = [...new Set((value as string[]).map((f) => f.trim()).filter(Boolean))];
  if (files.length > ISSUE_IMAGES_PER_ENTRY) throw new HostError("bad_request", `一次最多 ${ISSUE_IMAGES_PER_ENTRY} 张图`);
  for (const f of files) {
    if (!isAbsolute(f)) throw new HostError("bad_request", `图片要写完整路径：${f}`);
    if (!IMAGE_TYPES[extname(f).toLowerCase()]) throw new HostError("bad_request", `只能传图片（png、jpg、gif、webp）：${f}`);
    let size: number;
    try {
      size = statSync(f).size;
    } catch {
      throw new HostError("bad_request", `找不到图片：${f}`);
    }
    if (size > IMAGE_MAX) throw new HostError("bad_request", `图片太大（最多 10 MB）：${f}`);
  }
  return files;
}
