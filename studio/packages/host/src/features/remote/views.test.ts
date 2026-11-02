import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_LOG_MAX, MAX_TEXT_FILE_BYTES, REMOTE_FILE_CHUNK, type GitChanges, type GitFileDiff, type GitStatus, type ModelProfile, type RemoteViewAsk, type Session, type Task, type TextFile, type ViewPack, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { answerView, placeInFolder, ViewAnswers, type ViewScope } from "./views.js";

// 远程 Reviewer on A (plans/remote-reviewer.md, 2026-11-02): what a paired device's Reviewer may read of a granted task,
// and every way out of it refused — another task's pack, another project, outside the task's folder (by `..`, by a
// link or junction), a file too big, a file no pack names.

const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];

let top: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let repo: Workspace;
let other: Workspace;
let task: Task;
let session: Session;
let otherTask: Task;
let otherSession: Session;
let scope: ViewScope;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();

beforeEach(async () => {
  top = mkdtempSync(join(tmpdir(), "amo-rviews-"));
  store = new Store(join(top, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(top, "common") });
  service.liveWindows = 1;
  const dir = join(top, "game");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(top, "secret"), { recursive: true });
  writeFileSync(join(dir, "src", "drop.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "quiet.ts"), "export const q = 1;\n");
  writeFileSync(join(dir, "README.md"), "# game\n");
  writeFileSync(join(top, "secret", "keys.txt"), "password=1\n");
  writeFileSync(join(top, "outside.txt"), "outside\n");
  repo = store.addWorkspace({ path: dir, name: "game" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(join(dir, "src", "drop.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "new.md"), "# 新文件\n");
  // A junction inside the project to a folder outside it, and a big file a pack names.
  symlinkSync(join(top, "secret"), join(dir, "out"), "junction");
  writeFileSync(join(dir, "big.log"), "x".repeat(MAX_TEXT_FILE_BYTES + 10));
  const otherDir = join(top, "tools");
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, "t.md"), "# tools\n");
  other = store.addWorkspace({ path: otherDir, name: "tools" });
  git(otherDir, "init", "-q", "-b", "main");
  task = store.createTask({ title: "掉落", workspaceId: repo.id });
  session = await service.tasks.addSession(task.id, { profileId: "p" });
  otherTask = store.createTask({ title: "别的任务", workspaceId: repo.id });
  otherSession = await service.tasks.addSession(otherTask.id, { profileId: "p" });
  scope = { host: service, task, root: dir };
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(top);
});

const pack = async (sessionId: string, items: unknown[], workspaceId?: string): Promise<ViewPack> => (await service.viewPacks.open({ items, ...(workspaceId ? { workspaceId } : {}) }, { sessionId })).pack;
const ask = (method: string, path: string, query?: Record<string, string>, body?: unknown): RemoteViewAsk => ({ taskId: task.id, method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) });
const view = <T,>(a: RemoteViewAsk) => answerView(scope, a) as Promise<T>;

describe("远程 Reviewer on A: packs", () => {
  it("reads a pack this task's session sent, and its proposal's diff", async () => {
    const p = await pack(session.id, [{ kind: "file", path: "src/drop.ts" }, { kind: "proposal", path: "src/quiet.ts", proposed: "export const q = 2;\n" }]);
    const got = await view<ViewPack>(ask("GET", `/api/viewpacks/${p.id}`));
    expect(got.id).toBe(p.id);
    const diff = await view<GitFileDiff>(ask("GET", `/api/viewpacks/${p.id}/items/${p.items[1]!.id}/diff`));
    expect(diff.lines.some((l) => l.kind === "add" && l.text.includes("q = 2"))).toBe(true);
  });

  it("refuses another task's pack, and a pack of this task in another project", async () => {
    const theirs = await pack(otherSession.id, [{ kind: "file", path: "README.md" }]);
    await expect(view(ask("GET", `/api/viewpacks/${theirs.id}`))).rejects.toThrow("不是这个任务里的查看包");
    await expect(view(ask("GET", `/api/viewpacks/${theirs.id}/items/${theirs.items[0]!.id}/diff`))).rejects.toThrow("不是这个任务里的查看包");
    const elsewhere = await pack(session.id, [{ kind: "file", path: "t.md" }], other.id);
    await expect(view(ask("GET", `/api/viewpacks/${elsewhere.id}`))).rejects.toThrow("别的项目");
    await expect(view(ask("GET", "/api/viewpacks/vp-nope"))).rejects.toThrow("不是这个任务里的查看包");
  });

  it("answers nothing but the Reviewer's reads", async () => {
    for (const [m, p] of [
      ["GET", "/api/state"],
      ["POST", "/api/viewpacks"],
      ["GET", "/api/fs/raw"],
      ["POST", `/api/workspaces/${repo.id}/review-comments`],
      ["GET", `/api/workspaces/${repo.id}/git/status/../../state`],
      ["DELETE", `/api/viewpacks/x`],
    ] as const)
      await expect(view(ask(m, p))).rejects.toThrow("只能看");
  });
});

describe("远程 Reviewer on A: git", () => {
  it("reads the task's project, without A's folder in the answer", async () => {
    const status = await view<GitStatus>(ask("GET", `/api/workspaces/${repo.id}/git/status`));
    expect(status.repo).toBe(true);
    expect(status.root).toBe("任务文件夹");
    const changes = await view<GitChanges>(ask("GET", `/api/workspaces/${repo.id}/git/changes`, { range: "working" }));
    expect(changes.files.map((f) => f.path).sort()).toEqual(expect.arrayContaining(["new.md", "src/drop.ts"]));
    expect(changes.status.root).toBe("任务文件夹");
    expect(JSON.stringify(changes)).not.toContain(top.replace(/\\/g, "/").split("/").pop()!);
    const diff = await view<GitFileDiff>(ask("GET", `/api/workspaces/${repo.id}/git/diff`, { range: "working", path: "src/drop.ts" }));
    expect(diff.lines.some((l) => l.kind === "add" && l.text.includes("a = 2"))).toBe(true);
    const log = await view<{ commits: unknown[] }>(ask("GET", `/api/workspaces/${repo.id}/git/log`));
    expect(log.commits.length).toBe(1);
  });

  it("refuses a Review whose target is not the task's project", async () => {
    await expect(view(ask("GET", `/api/workspaces/${other.id}/git/status`))).rejects.toThrow("不是这个任务的项目");
    await expect(view(ask("GET", `/api/workspaces/${other.id}/git/changes`))).rejects.toThrow("不是这个任务的项目");
  });

  it("refuses a diff of a path outside the folder, by .. or through a junction", async () => {
    await expect(view(ask("GET", `/api/workspaces/${repo.id}/git/diff`, { range: "working", path: "../outside.txt", untracked: "1" }))).rejects.toThrow("不在任务的文件夹里");
    await expect(view(ask("GET", `/api/workspaces/${repo.id}/git/diff`, { range: "working", path: "out/keys.txt", untracked: "1" }))).rejects.toThrow("junction");
    await expect(view(ask("GET", `/api/workspaces/${repo.id}/git/commit-diff`, { sha: "a".repeat(40), base: "b".repeat(40), path: "../outside.txt" }))).rejects.toThrow("不在任务的文件夹里");
  });

  // Review 2026-11-02: a diff of a file nobody pointed at is the whole file (an ignored one read as untracked, an
  // unchanged one as it is) — only files of the changes it is read in, or named by a pack, and A decides untracked.
  it("diffs only files of the range's changes or named by a pack; untracked is A's to say", async () => {
    const dir = scope.root;
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
    const diff = (query: Record<string, string>) => view<GitFileDiff>(ask("GET", `/api/workspaces/${repo.id}/git/diff`, { range: "working", ...query }));
    // An ignored file, even said to be untracked: refused.
    await expect(diff({ path: ".env", untracked: "1" })).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    await expect(diff({ path: "任务文件夹/.env" })).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    // A committed file without changes: refused (its diff would be the whole file).
    await expect(diff({ path: "src/quiet.ts" })).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    // Another range's list decides there: nothing is staged.
    await expect(view(ask("GET", `/api/workspaces/${repo.id}/git/diff`, { range: "staged", path: "src/drop.ts" }))).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    // Files of the changes read as always; what B says of untracked does not count.
    expect((await diff({ path: "src/drop.ts", untracked: "1" })).lines.some((l) => l.kind === "add" && l.text.includes("a = 2"))).toBe(true);
    expect((await diff({ path: "new.md", untracked: "0" })).lines.map((l) => l.kind)).toEqual(["add"]);
    // A rename's old path only as the list has it.
    await expect(diff({ path: "src/drop.ts", oldPath: "README.md" })).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    // A pack names the unchanged file: then it may be read.
    await pack(session.id, [{ kind: "file", path: "src/quiet.ts" }]);
    expect((await diff({ path: "src/quiet.ts" })).lines.map((l) => l.text)).toEqual(["export const q = 1;"]);
  });

  it("diffs a commit's files only, and caps the history a remote window asks for", async () => {
    const dir = scope.root;
    git(dir, "add", "src/drop.ts");
    git(dir, "commit", "-q", "-m", "second");
    const sha = git(dir, "rev-parse", "HEAD");
    const base = git(dir, "rev-parse", "HEAD~1");
    const commitDiff = (path: string) => view<GitFileDiff>(ask("GET", `/api/workspaces/${repo.id}/git/commit-diff`, { sha, base, path }));
    expect((await commitDiff("src/drop.ts")).lines.some((l) => l.kind === "add" && l.text.includes("a = 2"))).toBe(true);
    await expect(commitDiff("README.md")).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    await expect(commitDiff("src/quiet.ts")).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");
    // A pack naming a file does not open it in a commit that did not change it.
    await pack(session.id, [{ kind: "file", path: "README.md" }]);
    await expect(commitDiff("README.md")).rejects.toThrow("只能看查看包里点名的文件和改动里的文件");

    const asked: unknown[] = [];
    const log = service.gitReview.log.bind(service.gitReview);
    service.gitReview.log = (ws, limit) => (asked.push(limit), log(ws, limit));
    await view(ask("GET", `/api/workspaces/${repo.id}/git/log`, { limit: "1000000" }));
    await view(ask("GET", `/api/workspaces/${repo.id}/git/log`, { limit: "20" }));
    expect(asked).toEqual([GIT_LOG_MAX, "20"]);
  });
});

describe("远程 Reviewer on A: files", () => {
  it("reads a file a pack names, named by the task's folder", async () => {
    await pack(session.id, [{ kind: "file", path: "src/quiet.ts" }]);
    const f = await view<TextFile>(ask("GET", "/api/fs/text", { path: "src/quiet.ts", workspaceId: repo.id }));
    expect(f).toMatchObject({ path: "任务文件夹/src/quiet.ts", text: "export const q = 1;\n" });
    // The same file as 任务文件夹/… too.
    expect((await view<TextFile>(ask("GET", "/api/fs/text", { path: "任务文件夹/src/quiet.ts" }))).text).toBe("export const q = 1;\n");
  });

  it("reads a file the changes list (a Review's), but not one nobody pointed at", async () => {
    expect((await view<TextFile>(ask("GET", "/api/fs/text", { path: "new.md" }))).text).toBe("# 新文件\n");
    await expect(view(ask("GET", "/api/fs/text", { path: "src/quiet.ts" }))).rejects.toThrow("只能看查看包里点名的文件");
    await expect(view(ask("GET", "/api/fs/text", { path: "README.md", workspaceId: other.id }))).rejects.toThrow("不在这个任务的项目里");
  });

  it("refuses a file outside the folder, by .. , absolute or through a junction — even when a pack names it", async () => {
    await pack(session.id, [{ kind: "file", path: "README.md" }]);
    await expect(view(ask("GET", "/api/fs/text", { path: "../outside.txt" }))).rejects.toThrow("不在任务的文件夹里");
    await expect(view(ask("GET", "/api/fs/text", { path: join(top, "outside.txt") }))).rejects.toThrow("不在任务的文件夹里");
    await expect(view(ask("GET", "/api/fs/text", { path: "out/keys.txt" }))).rejects.toThrow("junction");
    expect(() => placeInFolder(scope.root, "out/keys.txt")).toThrow("junction");
  });

  it("does not send a file too big to show", async () => {
    await pack(session.id, [{ kind: "file", path: "big.log" }]);
    const f = await view<TextFile>(ask("GET", "/api/fs/text", { path: "big.log" }));
    expect(f).toMatchObject({ path: "任务文件夹/big.log", tooLarge: true });
    expect(f.text).toBeUndefined();
  });

  it("says which paths exist, only inside the folder", async () => {
    const r = await view<{ found: Record<string, { path: string; dir: boolean } | null> }>(ask("POST", "/api/fs/exists", undefined, { paths: ["README.md", "src", "../outside.txt", "out/keys.txt", join(top, "outside.txt"), "nope.md"], workspaceId: repo.id }));
    expect(r.found).toEqual({ "README.md": { path: "任务文件夹/README.md", dir: false }, src: { path: "任务文件夹/src", dir: true }, "../outside.txt": null, "out/keys.txt": null, [join(top, "outside.txt")]: null, "nope.md": null });
  });
});

describe("远程 Reviewer on A: big answers", () => {
  it("goes in pieces to the device that asked, and refuses what is too big", async () => {
    const answers = new ViewAnswers(4 * REMOTE_FILE_CHUNK);
    const big = "字".repeat(REMOTE_FILE_CHUNK); // three bytes each in UTF-8
    const first = await answers.serve("B", ask("GET", "/x"), async () => ({ big }));
    expect(first.id).toBeTruthy();
    expect(first.size).toBeGreaterThan(REMOTE_FILE_CHUNK);
    await expect(answers.serve("C", { ...ask("GET", "/x"), piece: { id: first.id!, offset: REMOTE_FILE_CHUNK } }, async () => null)).rejects.toThrow("从头再取");
    const parts = [Buffer.from(first.data, "base64")];
    let got = parts[0]!.length;
    while (got < first.size) {
      const next = await answers.serve("B", { ...ask("GET", "/x"), piece: { id: first.id!, offset: got } }, async () => null);
      parts.push(Buffer.from(next.data, "base64"));
      got += parts.at(-1)!.length;
    }
    expect(JSON.parse(Buffer.concat(parts).toString("utf8"))).toEqual({ big });
    await expect(answers.serve("B", ask("GET", "/x"), async () => ({ big: big + big }))).rejects.toThrow("太大");
    const small = await answers.serve("B", ask("GET", "/x"), async () => ({ ok: 1 }));
    expect(small.id).toBeUndefined();
  });
});
