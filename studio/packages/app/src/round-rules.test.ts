import { describe, expect, it } from "vitest";
import { roundHash, RoundSet, roundTarget } from "./round-rules.js";

// 会话弹窗 as a window of its own (2026-11-17): what a page may ask, the window's address, and which window is reused.

describe("round windows", () => {
  it("takes a card's request only with its task, session and building", () => {
    expect(roundTarget({ taskId: "t-1", sessionId: "s-2", towerFor: "s-1", itemId: "i-9", title: "3F · 核对\n掉落表" })).toEqual({ taskId: "t-1", sessionId: "s-2", towerFor: "s-1", itemId: "i-9", title: "3F · 核对 掉落表" });
    expect(roundTarget({ taskId: "t-1", sessionId: "s-1", towerFor: "s-1" })).toEqual({ taskId: "t-1", sessionId: "s-1", towerFor: "s-1" });
    expect(roundTarget({ taskId: "t-1", sessionId: "s-1" })).toBeNull();
    expect(roundTarget({ taskId: "t 1", sessionId: "s-1", towerFor: "s-1" })).toBeNull();
    expect(roundTarget(null)).toBeNull();
    // A bad row id is left out, not the whole card; a long title is cut.
    expect(roundTarget({ taskId: "t", sessionId: "s", towerFor: "s", itemId: "../x" })).toEqual({ taskId: "t", sessionId: "s", towerFor: "s" });
    expect(roundTarget({ taskId: "t", sessionId: "s", towerFor: "s", title: "长".repeat(500) })?.title).toHaveLength(200);
  });

  it("puts the card in the address, with a nonce that changes every time", () => {
    const hash = roundHash({ taskId: "t-1", sessionId: "s-2", towerFor: "s-1", itemId: "i-9", title: "3F · 核对" }, 7);
    expect(hash.startsWith("#round?")).toBe(true);
    const q = new URLSearchParams(hash.split("?")[1]);
    expect(Object.fromEntries(q)).toEqual({ task: "t-1", session: "s-2", tower: "s-1", item: "i-9", title: "3F · 核对", n: "7" });
    expect(roundHash({ taskId: "t", sessionId: "s", towerFor: "s" }, 8)).toBe("#round?task=t&session=s&tower=s&n=8");
  });

  it("reuses the one not pinned, keeps pinned ones, and tells which are open", () => {
    const set = new RoundSet<string>();
    const a = { taskId: "t", sessionId: "s1", towerFor: "s1" };
    const b = { taskId: "t", sessionId: "s2", towerFor: "s1" };
    expect(set.target()).toBeNull();
    set.created("w1", a);
    expect(set.target()).toBe("w1");
    set.shown("w1", b);
    expect(set.targetOf("w1")).toEqual(b);
    // 固定: it stays, the next card opens another.
    expect(set.pin("w1")).toBe(true);
    expect(set.isPinned("w1")).toBe(true);
    expect(set.target()).toBeNull();
    set.created("w2", a);
    expect(set.target()).toBe("w2");
    expect(set.list()).toEqual([
      { id: 1, taskId: "t", sessionId: "s2", towerFor: "s1", pinned: true },
      { id: 2, taskId: "t", sessionId: "s1", towerFor: "s1", pinned: false },
    ]);
    // The building's card let go closes only the one not pinned; the building gone closes them all.
    expect(set.ofTower("s1", false)).toEqual(["w2"]);
    expect(set.ofTower("s1", true)).toEqual(["w1", "w2"]);
    expect(set.ofTower("other", true)).toEqual([]);
    // 切到弹窗: the one not pinned first.
    expect(set.showing("s1")).toBe("w2");
    expect(set.showing("s2")).toBe("w1");
    expect(set.showing("s3")).toBeNull();
    expect(set.pin("nope")).toBe(false);
    set.closed("w2");
    expect(set.target()).toBeNull();
    expect(set.all()).toEqual(["w1"]);
    set.closed("w1");
    expect(set.list()).toEqual([]);
  });
});
