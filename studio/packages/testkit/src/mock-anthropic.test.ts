import { describe, expect, it } from "vitest";
import { defaultClaudeScript, parseClaudeRequest } from "./mock-anthropic.js";

const reminder = { type: "text", text: "<system-reminder>context</system-reminder>" };
const tools = [{ name: "Bash" }, { name: "Agent" }];

describe("mock Anthropic request parsing", () => {
  it("finds the person's text behind injected context, with trailing system messages", () => {
    const req = parseClaudeRequest({
      stream: true,
      tools,
      messages: [
        { role: "user", content: [reminder, { type: "text", text: "[[shell: mkdir x]]" }] },
        { role: "system", content: [{ type: "text", text: "# Environment" }] },
      ],
    });
    expect(req).toMatchObject({ lastUserText: "[[shell: mkdir x]]", afterToolOutput: false, subagent: null, tools: ["Bash", "Agent"], stream: true });
    expect(defaultClaudeScript(req)).toEqual({ kind: "tool_use", name: "Bash", input: { command: "mkdir x", description: "mock command" } });
  });

  it("sees a tool result after the person's message even when context follows it", () => {
    const req = parseClaudeRequest({
      tools,
      messages: [
        { role: "user", content: [reminder, { type: "text", text: "[[shell: mkdir x]]" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "system", content: [{ type: "text", text: "<total_tokens>…" }] },
      ],
    });
    expect(req.afterToolOutput).toBe(true);
    expect(defaultClaudeScript(req)).toEqual({ kind: "text", text: "MOCK-DONE" });
  });

  it("treats a message folded in with a tool result as what the person said last", () => {
    const req = parseClaudeRequest({
      tools,
      messages: [
        { role: "user", content: "[[shell: mkdir x]]" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "now the next thing" }] },
      ],
    });
    expect(req).toMatchObject({ lastUserText: "now the next thing", afterToolOutput: false });
  });

  it("recognises a subagent by its first message, and makes no tool call without the tool", () => {
    const sub = parseClaudeRequest({ tools: [{ name: "Bash" }], messages: [{ role: "user", content: [reminder, { type: "text", text: "[[subagent: helper]] say hi" }] }] });
    expect(defaultClaudeScript(sub)).toEqual({ kind: "text", text: "MOCK-SUB: helper" });
    const side = parseClaudeRequest({ messages: [{ role: "user", content: "[[shell: mkdir x]]" }] });
    expect(defaultClaudeScript(side)).toEqual({ kind: "text", text: "MOCK: [[shell: mkdir x]]" });
  });

  it("runs subagents in the foreground unless asked for the background", () => {
    const req = (text: string) => parseClaudeRequest({ tools, messages: [{ role: "user", content: text }] });
    expect(defaultClaudeScript(req("[[spawn: a: go]]"))).toMatchObject({ name: "Agent", input: { run_in_background: false, prompt: "[[subagent: a]] go" } });
    expect(defaultClaudeScript(req("[[spawn-bg: b: go]]"))).toMatchObject({ name: "Agent", input: { run_in_background: true } });
  });

  it("spawns before running a nested command, and passes a requested mode through", () => {
    const parent = parseClaudeRequest({ tools, messages: [{ role: "user", content: "[[spawn-mode-bypassPermissions: h: [[shell: mkdir x]]]]" }] });
    expect(defaultClaudeScript(parent)).toMatchObject({ name: "Agent", input: { mode: "bypassPermissions", prompt: "[[subagent: h]] [[shell: mkdir x]]" } });
    const sub = parseClaudeRequest({ tools, messages: [{ role: "user", content: "[[subagent: h]] [[shell: mkdir x]]" }] });
    expect(defaultClaudeScript(sub)).toMatchObject({ kind: "tool_use", name: "Bash", input: { command: "mkdir x" } });
  });
});
