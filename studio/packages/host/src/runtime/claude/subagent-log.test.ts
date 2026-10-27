import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { subagentLogFile, subagentStats, subagentStatsOf } from "./subagent-log.js";

// A Claude subagent's tokens and speed from its transcript (2026-10-27): the SDK sent only each call's starting output
// count, so Studio's live count was far too low and there was no speed.

const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 3, 0, 0) + s * 1000).toISOString();
const assistant = (id: string, s: number, output: number, input = 10, read = 1000) =>
  JSON.stringify({ type: "assistant", timestamp: at(s), message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } } });
const user = (s: number) => JSON.stringify({ type: "user", timestamp: at(s), message: { role: "user" } });

const log = [
  user(0),
  // Call 1: two blocks; the later one has the real output count. Asked at 0, last block at 4.
  assistant("m1", 2, 7),
  assistant("m1", 4, 200),
  user(5),
  // Call 2: one block, asked at 5 (the tool result), written at 7.
  assistant("m2", 7, 100, 20, 1200),
  '{"type":"assistant","timestamp":"2026', // being written
].join("\n");

let root = "";
afterEach(() => root && removeTempDir(root));

describe("Claude subagent stats", () => {
  it("counts each call's largest output and measures it from its request to its last block", () => {
    expect(subagentStats(log)).toEqual({ input: 1010 + 1220, cachedInput: 2200, output: 300, decode: { ms: 4000 + 2000, tokens: 300, basis: "request" } });
    expect(subagentStats(user(0))).toBeNull();
  });

  it("finds a subagent's transcript by its Agent call, under whatever folder its cwd became", () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-sublog-"));
    const subs = join(root, "projects", "G--PROJECT-x", "sess-1", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "toolu_other" }));
    writeFileSync(join(subs, "agent-a1.jsonl"), user(0));
    writeFileSync(join(subs, "agent-a2.meta.json"), JSON.stringify({ toolUseId: "toolu_1" }));
    writeFileSync(join(subs, "agent-a2.jsonl"), log);
    const file = subagentLogFile(root, "sess-1", "toolu_1");
    expect(file).toBe(join(subs, "agent-a2.jsonl"));
    expect(subagentStatsOf(file!)?.output).toBe(300);
    expect(subagentLogFile(root, "sess-1", "toolu_none")).toBeNull();
    expect(subagentLogFile(root, "sess-2", "toolu_1")).toBeNull();
  });
});
