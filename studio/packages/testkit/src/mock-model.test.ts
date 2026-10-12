import { afterEach, describe, expect, it } from "vitest";
import { defaultScript, parseRequest, startMockModel, type MockModelServer } from "./mock-model.js";

let mock: MockModelServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const userMessage = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

async function post(body: unknown): Promise<Array<Record<string, any>>> {
  const res = await fetch(`${mock!.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}

describe("parseRequest", () => {
  it("extracts the last user text, tool names and tool-output continuation", () => {
    const req = parseRequest({
      input: [userMessage("first"), userMessage("second"), { type: "function_call_output", call_id: "c", output: "ok" }],
      tools: [{ type: "function", name: "shell_command" }, { type: "custom", name: "apply_patch" }],
    });
    expect(req.lastUserText).toBe("second");
    expect(req.tools).toEqual(["shell_command", "apply_patch"]);
    expect(req.afterToolOutput).toBe(true);
  });
});

describe("defaultScript", () => {
  const req = (text: string, tools = ["shell_command"]) => ({ lastUserText: text, afterToolOutput: false, agentTask: null, tools, lastTool: null, body: {} });

  it("spawns a subagent through the collaboration namespace and answers as that subagent", () => {
    expect(defaultScript(req("[[spawn: explorer: map it]]", ["collaboration", "collaboration.spawn_agent"]))).toEqual({
      kind: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: { task_name: "explorer", message: "map it", fork_turns: "none" },
    });
    expect(defaultScript({ ...req(""), agentTask: "/root/explorer" })).toEqual({ kind: "text", text: "MOCK-SUB: /root/explorer" });
  });

  it("echoes plain text", () => {
    expect(defaultScript(req("hi"))).toEqual({ kind: "text", text: "MOCK: hi" });
  });

  it("turns a shell directive into a tool call for the offered shell tool", () => {
    expect(defaultScript(req("[[shell: dir]]", ["exec_command", "write_stdin"]))).toEqual({ kind: "function_call", name: "exec_command", arguments: { cmd: "dir" } });
    expect(defaultScript(req("[[shell: cmd /c echo x]]"))).toEqual({ kind: "function_call", name: "shell_command", arguments: { command: "cmd /c echo x" } });
    expect(defaultScript(req("[[shell: ls]]", ["shell"]))).toEqual({ kind: "function_call", name: "shell", arguments: { command: ["cmd", "/c", "ls"] } });
  });
});

describe("startMockModel", () => {
  it("streams a text reply as Responses SSE events", async () => {
    mock = await startMockModel();
    const events = await post({ input: [userMessage("hello")], stream: true });
    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    expect(deltas).toBe("MOCK: hello");
    expect(events.at(-1)!.response.output[0].content[0].text).toBe("MOCK: hello");
    expect(mock.requests).toHaveLength(1);
  });

  it("streams a function call and then finishes after the tool output", async () => {
    mock = await startMockModel();
    const call = await post({ input: [userMessage("[[shell: dir]]")], tools: [{ type: "function", name: "shell_command" }] });
    const item = call.find((e) => e.type === "response.output_item.done")!.item;
    expect(item).toMatchObject({ type: "function_call", name: "shell_command" });
    expect(JSON.parse(item.arguments)).toEqual({ command: "dir" });

    const after = await post({ input: [userMessage("[[shell: dir]]"), { type: "function_call_output", call_id: item.call_id, output: "ok" }] });
    expect(after.at(-1)!.response.output[0].content[0].text).toBe("MOCK-DONE");
  });

  it("uses a custom script and answers 404 for other routes", async () => {
    mock = await startMockModel({ script: () => ({ kind: "text", text: "scripted", chunks: 1 }) });
    const events = await post({ input: [userMessage("x")] });
    expect(events.find((e) => e.type === "response.output_text.delta")!.delta).toBe("scripted");
    expect((await fetch(`${mock.baseUrl}/other`, { method: "POST" })).status).toBe(404);
  });
});
