import { afterEach, describe, expect, it } from "vitest";
import { attentionKeys, pruneSeen, readFocusLocked, shapeRects, shouldAlert, writeFocusLocked } from "./attention.js";

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
