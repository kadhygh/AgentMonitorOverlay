import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@amo-studio/protocol";
import type { ClaudeCore } from "./core.js";
import type { Live } from "./live.js";
import { ClaudeSubagents } from "./subagents.js";
import type { ClaudeTurns } from "./turns.js";

// 2026-11-25: end()'s second read of a subagent's transcript, 2 s later, ran after the store had closed — 「database is not
// open」 thrown from a timer, an unhandled error that fails the full unit run (and so 自动打包) though every test passed.
describe("ClaudeSubagents.end's second transcript read", () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    let closed = false;
    const logged: string[] = [];
    const reads: string[] = [];
    const child = { id: "child", parentId: "parent", runtimeRef: "ref/agent/tool-1" } as Session;
    const core = {
      log: (line: string) => logged.push(line),
      setStatus: () => undefined,
      store: {
        getSession: (id: string) => {
          if (closed) throw Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
          reads.push(id);
          return id === "child" ? child : undefined;
        },
      },
    } as unknown as ClaudeCore;
    const subagents = new ClaudeSubagents(core, {} as ClaudeTurns);
    const live = { subUsage: new Map() } as unknown as Live;
    return { subagents, live, logged, reads, close: () => (closed = true) };
  };

  it("does not throw when the store closed before it (logged instead)", () => {
    vi.useFakeTimers();
    const { subagents, live, logged, close } = setup();
    subagents.end(live, "child", "completed");
    close();
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(logged).toEqual([expect.stringMatching(/could not read the transcript of subagent child again: database is not open/)]);
  });

  it("is dropped on shutdown", () => {
    vi.useFakeTimers();
    const { subagents, live, reads, logged } = setup();
    subagents.end(live, "child", "completed");
    const before = reads.length;
    subagents.shutdown();
    vi.advanceTimersByTime(5000);
    expect(reads.length).toBe(before);
    expect(logged).toEqual([]);
  });
});
