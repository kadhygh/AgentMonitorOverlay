import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockClaudeEnv, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";

// The real Claude Agent SDK (and the Claude Code CLI it runs) against the mock Anthropic API, in a temp
// CLAUDE_CONFIG_DIR: no model budget, nothing under the person's ~/.claude.

let mock: ClaudeMockServer;
let root: string;
let cwd: string;
let env: Record<string, string>;

beforeAll(async () => {
  mock = await startMockAnthropic();
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd);
  // Inherited Claude/Anthropic variables (this may run inside Claude Code) must not leak into the child.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(ANTHROPIC_|CLAUDE)/i.test(k))) as Record<string, string>;
  env = { ...inherited, ...mockClaudeEnv(mock.baseUrl), CLAUDE_CONFIG_DIR: join(root, "claude-home") };
});

afterAll(async () => {
  await mock?.close();
  if (root) removeTempDir(root);
});

async function run(prompt: string, canUseTool?: Parameters<typeof query>[0]["options"] extends infer O ? (O extends { canUseTool?: infer C } ? C : never) : never) {
  const messages: SDKMessage[] = [];
  // permissionMode must be explicit: the CLI otherwise defaults to "auto", where a classifier approves instead of a person.
  for await (const m of query({ prompt, options: { cwd, env, settingSources: [], permissionMode: "default", ...(canUseTool ? { canUseTool } : {}) } })) messages.push(m);
  const text = messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => (m.type === "assistant" ? m.message.content : []))
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
  return { messages, text };
}

describe("mock Anthropic API with the Claude Agent SDK", () => {
  it("answers a plain message", async () => {
    const { messages, text } = await run("hello there");
    expect(text).toBe("MOCK: hello there");
    expect(messages.find((m) => m.type === "result")).toMatchObject({ subtype: "success", is_error: false });
    expect(existsSync(join(root, "claude-home", "projects"))).toBe(true);
  }, 120_000);

  it("asks before a command that changes files, then runs it", async () => {
    const asked: string[] = [];
    const { text } = await run("[[shell: mkdir mock-made-dir]]", async (toolName, input) => {
      asked.push(`${toolName}:${String(input.command)}`);
      return { behavior: "allow", updatedInput: input };
    });
    expect(asked).toEqual(["Bash:mkdir mock-made-dir"]);
    expect(existsSync(join(cwd, "mock-made-dir"))).toBe(true);
    expect(text).toBe("MOCK-DONE");
  }, 120_000);

  it("runs a foreground subagent whose messages point at the parent's Agent call", async () => {
    const { messages, text } = await run("[[spawn: helper: say hi]]", async (_name, input) => ({ behavior: "allow", updatedInput: input }));
    const agentCall = messages
      .flatMap((m) => (m.type === "assistant" ? m.message.content : []))
      .find((c) => c.type === "tool_use") as { id: string; name: string } | undefined;
    expect(agentCall?.name).toBe("Agent");
    expect(mock.requests.some((r) => r.subagent === "helper")).toBe(true);
    expect(messages.some((m) => "parent_tool_use_id" in m && m.parent_tool_use_id === agentCall?.id)).toBe(true);
    expect(text).toBe("MOCK-DONE");
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
  }, 120_000);

  it("runs a background subagent: the parent gets another turn when it ends", async () => {
    const { messages } = await run("[[spawn-bg: watcher: check later]]", async (_name, input) => ({ behavior: "allow", updatedInput: input }));
    expect(mock.requests.some((r) => r.subagent === "watcher")).toBe(true);
    const kinds = messages.map((m) => (m.type === "system" ? `system:${m.subtype}` : m.type));
    expect(kinds).toContain("system:task_notification");
    // One query, two turns: the launch, then the reaction to the notification.
    expect(messages.filter((m) => m.type === "result")).toHaveLength(2);
  }, 120_000);
});
