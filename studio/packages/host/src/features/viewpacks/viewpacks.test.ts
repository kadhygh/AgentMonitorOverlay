import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session, Task, ViewPack, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 查看包 (2026-10-23): an agent hands the person files and changes in one go; each item's kind checks it.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let repo: Workspace;
let task: Task;
let session: Session;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo.path, stdio: "pipe" }).toString().trim();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-viewpacks-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  service.liveWindows = 1;
  const dir = join(root, "game");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "drop.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  writeFileSync(join(dir, "README.md"), "# game\n");
  repo = store.addWorkspace({ path: dir, name: "game" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "src", "drop.ts"), "export const a = 1;\nexport const b = 20;\nexport const c = 3;\n");
  git("commit", "-q", "-am", "second");
  writeFileSync(join(dir, "README.md"), "# game\n\nnow\n");
  task = store.createTask({ title: "掉落", workspaceId: repo.id });
  session = await service.tasks.addSession(task.id, { profileId: "p-ds" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const events = () => {
  const list: HostEvent[] = [];
  service.on("event", (e: HostEvent) => list.push(e));
  return list;
};

describe("查看包", () => {
  it("makes a pack of several files with 重点, stores it and asks the workbench to show it", async () => {
    const seen = events();
    const { pack, merged } = await service.viewPacks.open(
      { items: [{ kind: "file", path: "src/drop.ts", highlights: [{ line: 2, note: "改成了 20" }, { line: 1, endLine: 3, note: "整段" }] }, { kind: "file", path: join(repo.path, "README.md") }] },
      { sessionId: session.id },
    );
    expect(merged).toBe(false);
    expect(pack).toMatchObject({ workspaceId: repo.id, sessionId: session.id, title: "2 项" });
    expect(pack.items).toMatchObject([
      { kind: "file", path: "src/drop.ts", highlights: [{ line: 2, note: "改成了 20" }, { line: 1, endLine: 3, note: "整段" }] },
      { kind: "file", path: "README.md", highlights: [] },
    ]);
    expect(service.viewPacks.get(pack.id)).toEqual(pack);
    expect(service.viewPacks.list(session.id).map((p) => p.id)).toEqual([pack.id]);
    expect(seen.some((e) => e.type === "viewpack.open" && e.packId === pack.id)).toBe(true);
  });

  it("refuses what cannot be shown, naming the item", async () => {
    const open = (items: unknown[]) => service.viewPacks.open({ items }, { sessionId: session.id });
    await expect(open([{ kind: "file", path: "src/drop.ts" }, { kind: "file", path: "nope.ts" }])).rejects.toThrow(/items\[1\]: file nope.ts not found/);
    await expect(open([{ kind: "file", path: "../outside.txt" }])).rejects.toThrow(/inside the project folder/);
    await expect(open([{ kind: "file", path: "src" }])).rejects.toThrow(/folder/);
    await expect(open([{ kind: "file", path: "src/drop.ts", highlights: [{ line: 5, endLine: 2 }] }])).rejects.toThrow(/at least its line/);
    await expect(open([{ kind: "movie" }])).rejects.toThrow(/kind must be one of/);
    await expect(open([])).rejects.toThrow(/items must be a list/);
    service.liveWindows = 0;
    await expect(open([{ kind: "file", path: "src/drop.ts" }])).rejects.toThrow(/窗口没有打开/);
  });

  it("git items resolve their refs: uncommitted changes, a commit, a range from where it forked, some files only", async () => {
    const head = git("rev-parse", "HEAD");
    const first = git("rev-parse", "HEAD~1");
    const { pack } = await service.viewPacks.open(
      {
        items: [
          { kind: "git", files: ["README.md"] },
          { kind: "git", source: "commit", commit: "HEAD", files: ["src/drop.ts"] },
          { kind: "git", range: "HEAD~1...HEAD" },
          { kind: "git", base: "main" },
        ],
      },
      { sessionId: session.id },
    );
    expect(pack.items).toMatchObject([
      { kind: "git", source: { kind: "working" }, files: ["README.md"] },
      { kind: "git", source: { kind: "commit", commit: head }, files: ["src/drop.ts"] },
      { kind: "git", source: { kind: "commit", commit: head, base: first, label: "HEAD~1 的分叉点" }, files: [] },
      { kind: "git", source: { kind: "base", base: head, label: "main" } },
    ]);
    await expect(service.viewPacks.open({ items: [{ kind: "git", commit: "no-such-ref" }] }, { sessionId: session.id })).rejects.toThrow(/找不到 no-such-ref/);
  });

  it("a proposal keeps the file as it was and shows the change as a diff; nothing on disk changes", async () => {
    const { pack } = await service.viewPacks.open(
      { items: [{ kind: "proposal", path: "src/drop.ts", proposed: "export const a = 1;\nexport const b = 200;\nexport const c = 3;\nexport const d = 4;\n" }, { kind: "proposal", path: "src/new.ts", proposed: "x\n" }] },
      { sessionId: session.id },
    );
    expect(pack.items[0]).toMatchObject({ kind: "proposal", isNew: false, original: "export const a = 1;\nexport const b = 20;\nexport const c = 3;\n" });
    expect(pack.items[1]).toMatchObject({ kind: "proposal", isNew: true, original: "" });
    const diff = await service.viewPacks.diff(pack.id, pack.items[0]!.id);
    expect(diff.lines.map((l) => `${l.kind}:${l.oldLine ?? ""}:${l.newLine ?? ""}:${l.text}`)).toEqual([
      "context:1:1:export const a = 1;",
      "del:2::export const b = 20;",
      "add::2:export const b = 200;",
      "context:3:3:export const c = 3;",
      "add::4:export const d = 4;",
    ]);
    expect(diff.hunks).toHaveLength(1);
    expect((await service.viewPacks.diff(pack.id, pack.items[1]!.id)).lines).toEqual([{ kind: "add", oldLine: null, newLine: 1, text: "x" }]);
    expect(git("status", "--porcelain")).toBe("M README.md");
    await expect(service.viewPacks.diff(pack.id, "nope")).rejects.toThrow(/not found/);
  });

  it("the same session sending again a moment later adds to its pack; the same file's 重点 join; another session gets its own", async () => {
    const first = await service.viewPacks.open({ items: [{ kind: "file", path: "src/drop.ts", highlights: [{ line: 1, note: "a" }] }] }, { sessionId: session.id });
    const second = await service.viewPacks.open({ items: [{ kind: "file", path: "README.md" }, { kind: "file", path: "src/drop.ts", highlights: [{ line: 2, note: "b" }] }] }, { sessionId: session.id });
    expect(second.merged).toBe(true);
    expect(second.pack.id).toBe(first.pack.id);
    expect(second.pack.items.map((i) => (i.kind === "file" ? `${i.path}:${i.highlights.map((h) => h.note).join("")}` : ""))).toEqual(["src/drop.ts:ab", "README.md:"]);
    const other = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    expect((await service.viewPacks.open({ items: [{ kind: "file", path: "README.md" }] }, { sessionId: other.id })).merged).toBe(false);
    // Later than a moment: a new pack.
    const stale: ViewPack = { ...second.pack, updatedAt: new Date(Date.now() - 60_000).toISOString() };
    store.putViewPack(stale);
    expect((await service.viewPacks.open({ items: [{ kind: "file", path: "README.md" }] }, { sessionId: session.id })).merged).toBe(false);
  });
});
