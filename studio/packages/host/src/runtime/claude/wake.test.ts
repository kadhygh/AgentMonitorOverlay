import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { agentToolUseId, isUsageLimitText, keepsProcess, LIMIT_CONTINUE_GRACE_MS, LIMIT_CONTINUE_TEXT, LIMIT_KEEP_MS, LOOP_AFTER_RESTART_MS, LOOP_LATE_MS, loopFromScheduleWakeup, studioWakeDue } from "./wake.js";

const now = new Date("2026-10-16T02:00:00.000Z");
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
const dirs: string[] = [];

afterAll(() => dirs.forEach(removeTempDir));

describe("wake", () => {
  it("recognises the CLI's usage-limit text", () => {
    expect(isUsageLimitText("You've hit your session limit · resets 12:30am (Asia/Hong_Kong)")).toBe(true);
    expect(isUsageLimitText("  You've reached your weekly limit")).toBe(true);
    expect(isUsageLimitText("MOCK: You've hit your session limit")).toBe(false);
  });

  it("reads a ScheduleWakeup call: the CLI's time, else the delay asked; or a stop", () => {
    const input = { delaySeconds: 1800, reason: "兜底", prompt: "/loop go on" };
    expect(loopFromScheduleWakeup(input, { scheduledFor: Date.parse(at(1_822_000)) }, now)).toEqual({ stop: false, loop: { at: at(1_822_000), reason: "兜底", prompt: "/loop go on" } });
    expect(loopFromScheduleWakeup({ ...input, delaySeconds: 5 }, undefined, now)).toEqual({ stop: false, loop: { at: at(60_000), reason: "兜底", prompt: "/loop go on" } });
    expect(loopFromScheduleWakeup({ stop: true }, undefined, now)).toEqual({ stop: true });
  });

  it("goes on after a usage limit only when asked, a little after the reset, with the loop's prompt in a loop", () => {
    const limit = { resetsAt: at(3_600_000), message: "You've hit your session limit", autoContinue: true };
    expect(studioWakeDue({ limit }, true, now)).toEqual({ at: Date.parse(limit.resetsAt) + LIMIT_CONTINUE_GRACE_MS, text: LIMIT_CONTINUE_TEXT, why: "limit" });
    const loop = { at: at(600_000), reason: "", prompt: "/loop go on" };
    expect(studioWakeDue({ loop, limit }, true, now)?.text).toBe("/loop go on");
    expect(studioWakeDue({ limit: { ...limit, autoContinue: false } }, true, now)).toBeNull();
    expect(studioWakeDue({ limit: { ...limit, resetsAt: null } }, true, now)).toBeNull();
  });

  it("sends a loop's wakeup itself only when the CLI is late, or its process is gone", () => {
    const loop = { at: at(600_000), reason: "", prompt: "/loop go on" };
    expect(studioWakeDue({ loop }, true, now)?.at).toBe(Date.parse(loop.at) + LOOP_LATE_MS);
    expect(studioWakeDue({ loop }, false, now)?.at).toBe(Date.parse(loop.at));
    // Its time passed while no process ran (a Host restart): shortly after.
    expect(studioWakeDue({ loop: { ...loop, at: at(-600_000) } }, false, now)?.at).toBe(now.getTime() + LOOP_AFTER_RESTART_MS);
    expect(studioWakeDue({ loop: { ...loop, prompt: "" } }, false, now)).toBeNull();
    expect(studioWakeDue(null, false, now)).toBeNull();
  });

  it("keeps the process through a loop, and through a usage limit until a while after its reset", () => {
    expect(keepsProcess({ loop: { at: at(60_000), reason: "", prompt: "/loop" } }, now)).toBe(true);
    const limit = { resetsAt: at(-LIMIT_KEEP_MS + 1000), message: "", autoContinue: false };
    expect(keepsProcess({ limit }, now)).toBe(true);
    expect(keepsProcess({ limit: { ...limit, resetsAt: at(-LIMIT_KEEP_MS - 1000) } }, now)).toBe(false);
    expect(keepsProcess({ limit: { ...limit, resetsAt: null } }, now)).toBe(true);
    expect(keepsProcess(undefined, now)).toBe(false);
  });

  it("finds the Agent call of a background agent in the CLI's own record", () => {
    const home = mkdtempSync(join(tmpdir(), "amo-studio-test-wake-"));
    dirs.push(home);
    const sub = join(home, "projects", "E--work", "sess-1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a142af52110ef1772.meta.json"), JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_016YZ" }));
    expect(agentToolUseId(home, "sess-1", "a142af52110ef1772")).toBe("toolu_016YZ");
    expect(agentToolUseId(home, "sess-1", "a-missing")).toBeNull();
    expect(agentToolUseId(home, "sess-1", "../x")).toBeNull();
  });
});
