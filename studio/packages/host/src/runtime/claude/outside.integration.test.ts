import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, OutsideSessionList, OutsideSessionPreview, Session, SessionItem, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, type ClaudeMockServer, mockClaudeProvider } from "@amo-studio/testkit";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { RuntimeRouter } from "../runtime.js";
import { ClaudeAccounts } from "./accounts.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { adoptedKey } from "./outside.js";

// 接续已有会话 (2026-11-05, plans/resume-cli-sessions.md), through HostService: a session the Claude desktop app left in
// the person's config dir (written here as Claude Code writes one) is listed, previewed and taken on by a new task —
// from a copy, its conversation imported, the model seeing the whole of it — and is not listed again.

const SUB: ModelProfile = { id: "claude-sub", label: "Claude", runtime: "claude", provider: "mock-oauth", model: MOCK_CLAUDE_MODEL, credentialId: "claude-subscription" };
const TOKEN: ModelProfile = { id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" };

let root: string;
let mine: string;
let mock: ClaudeMockServer;
let store: Store;
let claude: ClaudeRuntime;
let service: HostService;
let workspace: Workspace;

const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const items = (id: string) => store.listItems(id);
const agentTexts = (id: string) => items(id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);
const userTexts = (id: string) => items(id).filter((i): i is Extract<SessionItem, { type: "user" }> => i.type === "user").map((i) => i.text);

/** Claude Code's folder name for a project folder. */
const projectDir = (cwd: string) => join(mine, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

/** A transcript as Claude Code writes one: a chain of entries by parentUuid; `compactAfter` puts a compaction there. */
function writeTranscript(cwd: string, entrypoint: string, turns: Array<[string, string]>, opts: { title?: string; compactAfter?: number } = {}): string {
  const id = randomUUID();
  const base = { isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.300", gitBranch: "main", entrypoint };
  const lines: object[] = [];
  let parent: string | null = null;
  let t = Date.now() - 3600_000;
  const push = (entry: Record<string, unknown>) => {
    const uuid = randomUUID();
    lines.push({ ...base, parentUuid: parent, uuid, timestamp: new Date((t += 1000)).toISOString(), ...entry });
    parent = uuid;
  };
  turns.forEach(([ask, reply], i) => {
    push({ type: "user", message: { role: "user", content: ask } });
    push({ type: "assistant", message: { id: `msg_${i}`, type: "message", role: "assistant", model: MOCK_CLAUDE_MODEL, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    if (opts.compactAfter === i) {
      const logical = parent;
      parent = null;
      push({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", logicalParentUuid: logical, compactMetadata: { trigger: "auto", preTokens: 1000 } });
      push({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: they talked about apples." } });
    }
  });
  if (opts.title) lines.push({ type: "custom-title", customTitle: opts.title, sessionId: id });
  mkdirSync(projectDir(cwd), { recursive: true });
  writeFileSync(join(projectDir(cwd), `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return id;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-outside-"));
  mkdirSync(join(root, "workspace"));
  // A stand-in for ~/.claude with a login in it (the CLI sends its access token to the mock as it would to Anthropic).
  mine = join(root, "my-claude");
  mkdirSync(mine, { recursive: true });
  const expiresAt = Date.now() + 365 * 24 * 3600_000;
  writeFileSync(join(mine, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-outside-test", refreshToken: "sk-ant-ort01-outside-test", expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  const profiles = [SUB, TOKEN];
  claude = new ClaudeRuntime({
    accounts: new ClaudeAccounts(store, { defaultDir: mine, defaultExplicit: true, root: join(root, "accounts") }),
    store,
    profiles,
    providers: { mock: mockClaudeProvider(mock.baseUrl), "mock-oauth": mockClaudeProvider(mock.baseUrl, { auth: "oauth" }) },
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    claudeHome: join(root, "claude-home"),
    localClaudeHome: mine,
  });
  service = new HostService(store, new RuntimeRouter(store, profiles, { claude }), profiles);
  workspace = store.addWorkspace({ path: join(root, "workspace"), name: "ws" });
});

afterAll(async () => {
  await claude?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("接续已有会话 (Claude)", () => {
  it("lists outside sessions, previews one, and a new task goes on from a copy of it with its conversation", async () => {
    // One from the desktop app in a worktree under the project, one from a terminal outside every project, compacted.
    const worktree = join(workspace.path, ".claude", "worktrees", "brave-otter");
    const desktop = writeTranscript(worktree, "claude-desktop", [["记住暗号 PINEAPPLE-42", "记住了。"], ["接下来做什么", "等你吩咐。"]], { title: "固定流程" });
    const elsewhere = join(root, "elsewhere");
    const cli = writeTranscript(elsewhere, "cli", [["old secret before compaction", "ok old"], ["after compaction", "reply after"]], { compactAfter: 0 });
    // Studio's own sessions (sdk-ts) are never listed.
    writeTranscript(workspace.path, "sdk-ts", [["studio's own", "mine"]]);

    const list: OutsideSessionList = await service.tasks.outsideSessions();
    expect(list.unavailable).toBeUndefined();
    expect(list.sessions.map((s) => s.id).sort()).toEqual([desktop, cli].sort());
    expect(list.sessions.find((s) => s.id === desktop)).toMatchObject({ title: "固定流程", source: "desktop", workspaceId: workspace.id, cwd: worktree, gitBranch: "main" });
    expect(list.sessions.find((s) => s.id === cli)).toMatchObject({ source: "cli", workspaceId: null });

    const preview: OutsideSessionPreview = await service.tasks.outsidePreview(desktop);
    expect(preview).toMatchObject({ total: 4, compacted: false });
    expect(preview.messages.at(-1)).toEqual({ role: "assistant", text: "等你吩咐。" });
    const compacted = await service.tasks.outsidePreview(cli);
    expect(compacted.compacted).toBe(true);
    expect(compacted.messages.map((m) => m.text)).toEqual(["after compaction", "reply after"]);

    // Taken on with a first message: the history comes first, then the reply, and the model saw the whole conversation.
    const { task, session } = await service.tasks.createTask({ title: "固定流程", workspaceId: workspace.id, firstSession: { profileId: "claude-sub", resumeFrom: desktop, text: "暗号是什么？" } });
    const s = session as Session;
    expect(task.title).toBe("固定流程");
    expect(s.runtimeRef).not.toBe(desktop);
    await until(() => agentTexts(s.id).includes("MOCK: 暗号是什么？") && store.getSession(s.id)!.status === "idle", "reply after 接续");
    expect(items(s.id)[0]).toMatchObject({ type: "notice", level: "info" });
    expect((items(s.id)[0] as { message: string }).message).toContain("原来在");
    expect(userTexts(s.id)).toEqual(["记住暗号 PINEAPPLE-42", "接下来做什么", "暗号是什么？"]);
    expect(agentTexts(s.id).slice(0, 2)).toEqual(["记住了。", "等你吩咐。"]);
    const sent = JSON.stringify(mock.requests.at(-1)!.body.messages);
    expect(sent).toContain("PINEAPPLE-42");
    expect(mock.requests.at(-1)!.authorization).toContain("outside-test");
    // The original is left as it was; the copy sits beside it and is the one that went on.
    const original = readFileSync(join(projectDir(worktree), `${desktop}.jsonl`), "utf8");
    expect(original).not.toContain("暗号是什么");
    expect(readdirSync(projectDir(worktree))).toContain(`${s.runtimeRef}.jsonl`);
    expect(store.getKv(adoptedKey(desktop))?.value).toBe(s.id);

    // Neither the original nor its copy is listed any more; taking it on again is refused.
    expect((await service.tasks.outsideSessions()).sessions.map((x) => x.id)).toEqual([cli]);
    await expect(service.tasks.createTask({ workspaceId: workspace.id, firstSession: { profileId: "claude-sub", resumeFrom: desktop } })).rejects.toThrow(/已经在 Studio 里/);

    // A compacted one without a first message: only what follows the last compaction, no summary, and no turn runs.
    const other = (await service.tasks.createTask({ title: "压缩过的", workspaceId: workspace.id, firstSession: { profileId: "claude-sub", resumeFrom: cli } })).session!;
    expect(userTexts(other.id)).toEqual(["after compaction"]);
    expect(agentTexts(other.id)).toEqual(["reply after"]);
    expect((items(other.id)[0] as { message: string }).message).toMatch(/压缩过上下文/);
    expect(store.getSession(other.id)!.status).not.toBe("running");
  }, 180_000);

  it("refuses what cannot be taken on", async () => {
    await expect(service.tasks.createTask({ workspaceId: workspace.id, firstSession: { profileId: "claude-mock", resumeFrom: randomUUID() } })).rejects.toThrow(/Claude 订阅/);
    await expect(service.tasks.createTask({ workspaceId: workspace.id, firstSession: { profileId: "claude-sub", resumeFrom: "not-an-id" } })).rejects.toThrow(/resumeFrom/);
    await expect(service.tasks.createTask({ workspaceId: workspace.id, firstSession: { profileId: "claude-sub", resumeFrom: randomUUID() } })).rejects.toThrow(/找不到/);
    expect(existsSync(mine)).toBe(true);
  }, 60_000);
});
