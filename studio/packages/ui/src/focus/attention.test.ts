import { afterEach, describe, expect, it } from "vitest";
import { ANGRY_AFTER_MS, attentionKeys, longestWait, miniStatus, opensFocus, pruneSeen, readFocusAutoExpand, readFocusCollapsed, trackFirstSeen, readFocusLocked, shapeRects, shouldAlert, writeFocusAutoExpand, writeFocusCollapsed, writeFocusLocked } from "./attention.js";

describe("Focus robot (S14-J)", () => {
  const keys = attentionKeys([{ id: "a", status: "awaiting-approval" }], ["d1"], ["p1"]);

  it("keys every session, decision and proposal that needs the person", () => {
    expect(keys).toEqual(["s:a:awaiting-approval", "d:d1", "p:p1"]);
  });

  it("alerts for anything not acknowledged, and stops once all is seen", () => {
    expect(shouldAlert(keys, new Set())).toBe(true);
    expect(shouldAlert(keys, new Set(keys))).toBe(false);
    expect(shouldAlert([], new Set())).toBe(false);
    // Something new on top of what was seen: alert again.
    expect(shouldAlert([...keys, "s:b:awaiting-answer"], new Set(keys))).toBe(true);
  });

  it("forgets what was handled, so the same session asking again alerts again", () => {
    const seen = new Set(keys);
    const later = pruneSeen(seen, ["d:d1"]);
    expect([...later]).toEqual(["d:d1"]);
    expect(shouldAlert(["d:d1", "s:a:awaiting-approval"], later)).toBe(true);
  });

  it("the same session waiting for something else counts as new", () => {
    const seen = new Set(attentionKeys([{ id: "a", status: "awaiting-approval" }], [], []));
    expect(shouldAlert(attentionKeys([{ id: "a", status: "error" }], [], []), seen)).toBe(true);
  });
});

describe("锁定位置", () => {
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  afterEach(() => {
    store.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("is off until set, and remembered", () => {
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    expect(readFocusLocked()).toBe(false);
    writeFocusLocked(true);
    expect(readFocusLocked()).toBe(true);
    writeFocusLocked(false);
    expect(readFocusLocked()).toBe(false);
  });

  it("works without storage", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readFocusLocked()).toBe(false);
    expect(() => writeFocusLocked(true)).not.toThrow();
  });
});

describe("shapeRects", () => {
  it("keeps a margin around each part, inside the window, and drops empty ones", () => {
    expect(shapeRects([{ left: 10, top: 400, width: 360, height: 150.4 }, { left: 0, top: 0, width: 0, height: 10 }], { width: 380, height: 560 })).toEqual([{ x: 2, y: 392, width: 376, height: 167 }]);
    expect(shapeRects([{ left: 0, top: 0, width: 380, height: 560 }], { width: 380, height: 560 })).toEqual([{ x: 0, y: 0, width: 380, height: 560 }]);
  });
});

describe("the robot gets angry when left waiting (2026-10-15 evening)", () => {
  it("remembers when each thing first appeared, and forgets what went away", () => {
    const first = trackFirstSeen(new Map(), ["a", "b"], 1000);
    const later = trackFirstSeen(first, ["b", "c"], 5000);
    expect([...later]).toEqual([
      ["b", 1000],
      ["c", 5000],
    ]);
  });

  it("measures the longest wait among what was not acknowledged", () => {
    const first = new Map([
      ["old", 0],
      ["new", ANGRY_AFTER_MS - 1000],
    ]);
    expect(longestWait(["old", "new"], new Set(), first, ANGRY_AFTER_MS)).toBe(ANGRY_AFTER_MS);
    // Acknowledging the old one leaves only the new one's wait.
    expect(longestWait(["old", "new"], new Set(["old"]), first, ANGRY_AFTER_MS)).toBe(1000);
    expect(longestWait([], new Set(), first, ANGRY_AFTER_MS)).toBe(0);
    expect(ANGRY_AFTER_MS).toBe(5 * 60_000);
  });
});

describe("收起成悬浮块 (2026-11-10)", () => {
  it("rests folded and does not open by itself on hover unless asked; both are kept", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readFocusCollapsed()).toBe(true);
    expect(readFocusAutoExpand()).toBe(false);
    writeFocusCollapsed(false);
    writeFocusAutoExpand(true);
    expect(readFocusCollapsed()).toBe(false);
    expect(readFocusAutoExpand()).toBe(true);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("shows the one thing that matters most on the tile", () => {
    expect(miniStatus(1, 3, 2)).toEqual({ tone: "att", text: "! 1", title: "需要你 1 · 完成待看 3 · 运行中 2" });
    expect(miniStatus(0, 3, 2)).toMatchObject({ tone: "done", text: "✓ 3" });
    expect(miniStatus(0, 0, 2)).toMatchObject({ tone: "run", text: "▶ 2" });
    expect(miniStatus(0, 0, 0)).toEqual({ tone: "idle", text: "—", title: "没有待处理" });
  });

  it("opens by itself only for something new that needs the person", () => {
    expect(opensFocus(null, ["d:1"])).toBe(true);
    expect(opensFocus(new Set(["d:1"]), ["d:1"])).toBe(false);
    expect(opensFocus(new Set(["d:1"]), ["d:1", "s:2:awaiting-approval"])).toBe(true);
    expect(opensFocus(new Set(["d:1"]), [])).toBe(false);
  });
});
