import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { allTurnStats, dshTurnStats, turnStats, zstdFrames } from "./session-log.js";

// A DSH session's speed and tokens from its own log (2026-10-22), measured as DSH's session-stats does.

const line = (type: string, time: number, data: Record<string, unknown>) => JSON.stringify({ type, seq: 0, time, data });
const usage = (input: number, output: number, cacheRead = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, totalTokens: input + output + cacheRead });

const log = [
  // An earlier turn: not counted.
  line("turn/start", 1000, { turn: 1 }),
  line("step/start", 1000, { turn: 1, step: 0 }),
  line("assistant/message", 2000, { turn: 1, step: 0, usage: usage(10, 999), stream: [{ type: "text-chunks", time0: 1100, index: 0, dt: [], texts: ["x"] }] }),
  line("turn/end", 2000, { turn: 1 }),
  line("turn/start", 10_000, { turn: 2 }),
  // Step 0: first token from the attempt (reasoning run: its first non-empty fragment at 10_200 + 50).
  line("step/start", 10_000, { turn: 2, step: 0 }),
  line("assistant/attempt", 10_100, { turn: 2, step: 0, stream: [{ type: "reasoning-chunks", time0: 10_200, index: 0, dt: [50, 10], texts: ["", "想", "一想"] }] }),
  line("assistant/message", 11_250, { turn: 2, step: 0, usage: usage(100, 200, 5000) }),
  line("tool/call", 11_300, { turn: 2, callId: "c1" }),
  // Step 1: first token from the message's stream (a named tool call starts at its first member).
  line("step/start", 12_000, { turn: 2, step: 1 }),
  line("assistant/message", 12_800, { turn: 2, step: 1, usage: usage(50, 100, 5200), stream: [{ type: "chunk", time: 12_100, chunk: { type: "block-start" } }, { type: "tool-call-chunks", time0: 12_300, index: 0, dt: [], id: "c2", name: "pwsh", args: ["{"] }] }),
  '{"type":"step/start","time":13000,"data":{"turn":2', // being written
].join("\n");

let root: string | undefined;
afterEach(() => {
  if (root) removeTempDir(root);
  root = undefined;
});

describe("DSH turn stats", () => {
  it("counts the last turn only: tokens, and generation from each call's first output token to its message", () => {
    expect(turnStats(log)).toEqual({
      startedAt: 10_000,
      input: 100 + 5000 + 50 + 5200,
      cachedInput: 10_200,
      output: 300,
      // Step 0: 11_250 - 10_250; step 1: 12_800 - 12_300.
      decode: { ms: 1000 + 500, tokens: 300 },
    });
  });

  it("measures every turn of a log, oldest first (filling in turns that ended unmeasured, 2026-10-27)", () => {
    const all = allTurnStats(log);
    expect(all.map((t) => t.startedAt)).toEqual([1000, 10_000]);
    expect(all[0]).toMatchObject({ output: 999, decode: { ms: 900, tokens: 999 } });
    expect(all[1]).toEqual(turnStats(log));
  });

  it("has no speed for a turn whose calls reported no usage, and nothing without a turn", () => {
    expect(turnStats([line("turn/start", 1, { turn: 1 }), line("step/start", 1, { turn: 1, step: 0 })].join("\n"))).toEqual({ startedAt: 1, input: 0, cachedInput: 0, output: 0 });
    expect(turnStats(line("session", 1, {}))).toBeNull();
  });

  it("finds the session's compressed log in a DSH home, under whatever folder its cwd became", () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshlog-"));
    const dir = join(root, "sessions", "--E-TOOLS-AMO--", "acp-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(log)));
    expect(dshTurnStats(root, "acp-1")?.decode).toEqual({ ms: 1500, tokens: 300 });
    expect(dshTurnStats(root, "acp-2")).toBeNull();
    // Cut short while being written: nothing this time.
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(log)).subarray(0, 20));
    expect(dshTurnStats(root, "acp-1")).toBeNull();
  });

  it("reads a log written one zstd frame per line, every frame, leaving out a last one cut short (2026-10-27)", () => {
    // As DSH writes it: each append its own frame. Electron's zstdDecompressSync stopped after the first one.
    const lines = log.split("\n").slice(0, -1).map((l) => `${l}\n`);
    const frames = lines.map((l) => zstdCompressSync(Buffer.from(l)));
    const whole = Buffer.concat(frames);
    expect(zstdFrames(whole)).toBe(lines.join(""));
    expect(zstdFrames(Buffer.concat([whole, frames[0]!.subarray(0, 7)]))).toBe(lines.join(""));
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshlog-"));
    const dir = join(root, "sessions", "--E-TOOLS-AMO--", "acp-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), whole);
    expect(dshTurnStats(root, "acp-1")?.decode).toEqual({ ms: 1500, tokens: 300 });
  });
});
