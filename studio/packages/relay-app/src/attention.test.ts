import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Attention, ATTENTION_FILE, tooltipText, writeAttention, type AttentionFile } from "./attention.js";

function setup(withFile = false) {
  const log: string[] = [];
  const files: Array<AttentionFile | null> = [];
  const attention = new Attention(
    {
      flash: (on) => log.push(`flash ${on}`),
      overlay: (n) => log.push(`overlay ${n}`),
      tray: (badge, n) => log.push(`tray ${badge ? n : "plain"}`),
      tooltip: (t) => log.push(`tip ${t}`),
      ...(withFile ? { write: (s: AttentionFile | null) => files.push(s) } : {}),
    },
    4242,
    500,
  );
  return { attention, log, files, take: () => log.splice(0) };
}

describe("中转's attention: taskbar and tray (2026-10-29)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a count while nobody looks: the taskbar flashes and carries it, the tray blinks with it", () => {
    const { attention, take } = setup();
    attention.setCount(3);
    expect(take()).toEqual(["flash true", "overlay 3", "tip AMO 中转 · 3 条待处理 / 未读", "tray 3"]);
    vi.advanceTimersByTime(500);
    expect(take()).toEqual(["tray plain"]);
    vi.advanceTimersByTime(500);
    expect(take()).toEqual(["tray 3"]);
    expect(attention.state).toEqual({ count: 3, inUse: false, blinking: true });
  });

  it("looked at: the flashing and blinking stop, the count stays; going down does not flash; none clears it", () => {
    const { attention, take } = setup();
    attention.setCount(2);
    attention.setInUse(true);
    take();
    vi.advanceTimersByTime(2000);
    expect(take()).toEqual([]);
    expect(attention.state.blinking).toBe(false);
    // More while looked at: no flash.
    attention.setCount(4);
    expect(take()).toEqual(["overlay 4", "tip AMO 中转 · 4 条待处理 / 未读", "tray 4"]);
    // Away again with 4 waiting: the tray blinks again; the taskbar does not flash for what was already seen.
    attention.setInUse(false);
    expect(take()).toEqual(["tray 4"]);
    expect(attention.state.blinking).toBe(true);
    attention.setCount(1);
    expect(take()).toEqual(["overlay 1", "tip AMO 中转 · 1 条待处理 / 未读", "tray 1"]);
    attention.setCount(0);
    expect(take()).toEqual(["flash false", "overlay 0", "tip AMO 中转", "tray plain"]);
    expect(attention.state).toEqual({ count: 0, inUse: false, blinking: false });
  });

  it("a newer one while away flashes again", () => {
    const { attention, take } = setup();
    attention.setCount(1);
    attention.setInUse(true);
    attention.setInUse(false);
    take();
    attention.setCount(2);
    expect(take()[0]).toBe("flash true");
  });

  it("for the platform: the file says the count and whether to blink, only when that changed; gone at the end", () => {
    const { attention, files } = setup(true);
    attention.setCount(5);
    attention.setCount(5);
    attention.setInUse(true);
    attention.setCount(0);
    attention.dispose();
    expect(files.map((f) => f && { count: f.count, blink: f.blink, pid: f.pid })).toEqual([
      { count: 5, blink: true, pid: 4242 },
      { count: 5, blink: false, pid: 4242 },
      { count: 0, blink: false, pid: 4242 },
      null,
    ]);
    expect(tooltipText(0)).toBe("AMO 中转");
  });

  it("writes the file whole and removes it", () => {
    vi.useRealTimers();
    const home = mkdtempSync(join(tmpdir(), "amo-relay-attention-"));
    try {
      writeAttention(home, { count: 2, blink: true, pid: 1, at: "x" });
      expect(JSON.parse(readFileSync(join(home, ATTENTION_FILE), "utf8"))).toEqual({ count: 2, blink: true, pid: 1, at: "x" });
      expect(existsSync(join(home, `${ATTENTION_FILE}.tmp`))).toBe(false);
      writeAttention(home, null);
      expect(existsSync(join(home, ATTENTION_FILE))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
