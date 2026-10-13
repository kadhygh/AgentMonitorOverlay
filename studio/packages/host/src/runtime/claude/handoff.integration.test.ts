import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { RecordingTerminalLauncher } from "../../terminal/launcher.js";
import { StaticCredentialReader } from "../credentials.js";
import { RuntimeRouter } from "../runtime.js";
import { ClaudeRuntime } from "./claude-runtime.js";

// Handing a Claude session to a terminal and taking it back, through HostService. The terminal itself is simulated:
// the launch is recorded, a turn "typed in the terminal" is run with the same command line in print mode (no window),
// and closing the terminal is the fake handle's exit().

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];

let root: string;
let mock: ClaudeMockServer;
let store: Store;
let claude: ClaudeRuntime;
let service: HostService;
let launcher: RecordingTerminalLauncher;
let workspace: Workspace;
let task: Task;

const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const items = (id: string) => store.listItems(id);
const agentTexts = (id: string) => items(id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);
const session = (id: string) => store.getSession(id)!;

/**
 * What a person typing one message into the handed-off terminal amounts to (print mode instead of the TUI). Async on
 * purpose: the mock API runs in this process and must keep answering while the CLI waits for it.
 */
async function typeInTerminal(index: number, text: string): Promise<void> {
  const launch = launcher.launches[index]!;
  const exe = /^& '(.+?)'/.exec(launch.command)![1]!;
  const args = launch.command.replace(/^& '.+?' /, "").split(" ");
  await promisify(execFile)(exe, ["-p", ...args, text], { cwd: launch.cwd, env: launch.env, windowsHide: true, timeout: 120_000 });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-handoff-"));
  mkdirSync(join(root, "workspace"));
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  claude = new ClaudeRuntime({
    store,
    profiles: PROFILES,
    providers: { mock: { baseUrl: mock.baseUrl } },
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    claudeHome: join(root, "claude-home"),
    baseEnv: { ...process.env, ANTHROPIC_API_KEY: "must-not-leak" },
  });
  launcher = new RecordingTerminalLauncher();
  service = new HostService(store, new RuntimeRouter(store, PROFILES, { claude }), PROFILES, { launcher });
  workspace = store.addWorkspace({ path: join(root, "workspace"), name: "ws" });
  task = store.createTask({ title: "handoff", workspaceId: workspace.id });
});

afterAll(async () => {
  await claude?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("Claude terminal handoff", () => {
  it("hands over, stays read-only, and takes back what the terminal added when it closes", async () => {
    const s = await claude.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "hello" });
    await until(() => agentTexts(s.id).includes("MOCK: hello") && session(s.id).status === "idle", "first reply");

    const attach = await service.terminal(s.id, true);
    expect(attach).toMatchObject({ launched: true, envVar: null });
    const launch = launcher.launches[0]!;
    expect(launch).toMatchObject({ track: true, envMode: "replace", cwd: workspace.path });
    expect(launch.command).toMatch(new RegExp(`claude\\.exe' --resume ${s.runtimeRef} --permission-mode default$`));
    expect(launch.command).not.toContain("mock-key");
    expect(launch.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "mock-key", ANTHROPIC_BASE_URL: mock.baseUrl, CLAUDE_CONFIG_DIR: join(root, "claude-home") });
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(session(s.id).writer).toBe("terminal-handoff");
    await expect(service.sendMessage(s.id, "from studio")).rejects.toMatchObject({ code: "read_only" });

    await typeInTerminal(0, "from the terminal");
    launcher.handles[0]!.exit();
    await until(() => session(s.id).writer === "workbench", "reclaimed on exit");
    expect(items(s.id).slice(-3).map((i) => [i.type, (i as { text?: string; markdown?: string; message?: string }).text ?? (i as { markdown?: string }).markdown ?? (i as { message?: string }).message])).toEqual([
      ["user", "from the terminal"],
      ["agent", "MOCK: from the terminal"],
      ["notice", "已从终端收回，导入了终端里新增的 2 条内容。"],
    ]);

    await service.sendMessage(s.id, "back in studio");
    await until(() => agentTexts(s.id).includes("MOCK: back in studio"), "reply after reclaim");
    expect(JSON.stringify(mock.requests.at(-1)!.body.messages)).toContain("MOCK: from the terminal");
  }, 180_000);

  it("closes the terminal when the person takes the session back at once", async () => {
    const s = await claude.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "one" });
    await until(() => session(s.id).status === "idle" && agentTexts(s.id).length === 1, "reply");
    await service.terminal(s.id, true);
    const handle = launcher.handles.at(-1)!;
    const back = await service.reclaim(s.id);
    expect(handle.killed).toBe(true);
    expect(back.writer).toBe("workbench");
    expect(items(s.id).at(-1)).toMatchObject({ type: "notice", message: "已从终端收回。" });
  }, 120_000);

  it("refuses while a reply is being generated", async () => {
    const s = await claude.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "[[slow]]" });
    await until(() => session(s.id).status === "running", "slow reply");
    await expect(service.terminal(s.id, true)).rejects.toMatchObject({ code: "conflict" });
    expect(session(s.id).writer).toBe("workbench");
    await claude.interrupt(s.id);
  }, 120_000);
});
