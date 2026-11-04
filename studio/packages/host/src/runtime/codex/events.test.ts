import { describe, expect, it } from "vitest";
import { CodexEvents } from "./events.js";
import type { CodexAsks } from "./asks.js";
import type { CodexCore } from "./state.js";

describe("CodexEvents.handlerFailed", () => {
  // 2026-11-04: a message arriving while the Host shut down threw again from here (store closed), an uncaught exception
  // in the RPC client's handler that made the full unit run exit 1 and stopped 自动打包.
  it("does not throw when the session cannot be looked up (the store already closed)", () => {
    const logged: string[] = [];
    const core = {
      log: (line: string) => logged.push(line),
      findByThread: () => {
        throw Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
      },
    } as unknown as CodexCore;
    const events = new CodexEvents(core, {} as CodexAsks, () => undefined);
    expect(() => events.handlerFailed("item/completed", "thr-1", new Error("boom"))).not.toThrow();
    expect(logged[0]).toMatch(/failed to handle item\/completed/);
    expect(logged[1]).toMatch(/could not note the failure of item\/completed.*database is not open/);
  });
});
