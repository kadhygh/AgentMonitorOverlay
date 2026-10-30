import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { ISSUE_IMAGES_PER_ENTRY, ISSUE_STATUS_LABEL, ISSUE_STATUSES, RelayClient, RelayClientError, type Issue, type IssueList, type IssuePatch, type IssueStatus } from "@amo-studio/relay/light";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

// 问题页 ↔ 会话 (2026-10-31, plans/issues.md stage 3): a session reads the issues the person reported on the team
// server's /issues page and answers them — as the person (the platform's login, like 中转), each entry marked as the
// AI's. No built-in job: the person starts a 值守 item whose prompt names the prompt template that says how to work
// the issues (the user, 2026-10-31), and the session uses these tools. Screenshots are fetched into the data folder so
// the agent can open them.

export const ISSUES_NOT_SIGNED_IN = "要先在 AMO 平台里登录团队服务器，才能读写问题页。";
const IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
/** Statuses an issue is still open in (for 值守's list). */
const OPEN = new Set<IssueStatus>(["new", "working", "asking", "fixed", "stuck"]);

export interface IssueLine {
  number: number;
  title: string;
  status: IssueStatus;
  statusLabel: string;
  tool: string;
  version: string;
  worker: string;
  fixedIn: string;
  /** The person wrote last: something to read and answer. */
  awaitsAi: boolean;
  updatedAt: string;
}

export class IssuesFeature extends Feature {
  private client(): RelayClient {
    const login = this.f.remote.teamLogin();
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
      .map((i) => ({ number: i.number, title: i.title, status: i.status, statusLabel: ISSUE_STATUS_LABEL[i.status], tool: i.tool, version: i.version, worker: i.worker, fixedIn: i.fixedIn, awaitsAi: i.awaitsAi, updatedAt: new Date(i.updatedAt).toISOString() }));
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
  async reply(number: number, input: { body?: string; status?: string; images?: unknown }): Promise<Issue> {
    const files = localImages(input.images);
    const st = input.status === undefined ? undefined : issueStatus(input.status);
    return this.call(async (c) => {
      const ids: string[] = [];
      for (const f of files) ids.push((await c.uploadIssueImage(basename(f), readFileSync(f), IMAGE_TYPES[extname(f).toLowerCase()]!)).id);
      return c.addIssueEntry(number, { body: input.body ?? "", images: ids, ai: true, ...(st ? { status: st } : {}) });
    });
  }

  /** Status, title, who works on it, the build it went out in — each marked as the AI's. */
  async update(number: number, patch: { status?: string; title?: string; worker?: string; fixedIn?: string }): Promise<Issue> {
    const p: IssuePatch = {};
    if (patch.status !== undefined) p.status = issueStatus(patch.status);
    if (patch.title !== undefined) p.title = patch.title;
    if (patch.worker !== undefined) p.worker = patch.worker;
    if (patch.fixedIn !== undefined) p.fixedIn = patch.fixedIn;
    if (!Object.keys(p).length) throw new HostError("bad_request", "没有要改的（status、title、worker、fixedIn）");
    return this.call((c) => c.updateIssue(number, { ...p, ai: true }));
  }

  /** A test build went out: the issues it fixed become 已发布 with that version, and 发布打包's request is done. */
  async released(version: string, numbers: number[]): Promise<{ release: IssueList["release"]; released: number[] }> {
    if (!version.trim()) throw new HostError("bad_request", "要写发布的版本（例如 Studio 0.9.17）");
    const out = await this.call((c) => c.issueReleased(version.trim(), numbers));
    return { release: out.release, released: numbers.filter((n) => out.issues.some((i) => i.number === n && i.status === "released")) };
  }
}

function issueStatus(value: string): IssueStatus {
  if (!(ISSUE_STATUSES as readonly string[]).includes(value)) throw new HostError("bad_request", `状态只能是 ${ISSUE_STATUSES.join("、")}`);
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
