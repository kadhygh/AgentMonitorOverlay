import { describe, expect, it } from "vitest";
import { cardWindowOpen, composerInWindow, parseRoundHash, roundChatTarget, roundList } from "./rounds.js";

// 会话弹窗 as windows of their own (2026-11-16): what the workbench makes of the shell's list, and a window's address.

describe("会话弹窗 windows", () => {
  const list = roundList([
    { id: 1, taskId: "t", sessionId: "s1", towerFor: "s1", pinned: true },
    { id: 2, taskId: "t", sessionId: "sub", towerFor: "s1", pinned: false },
    { id: 3, taskId: "t", sessionId: "x" },
    null,
  ]);

  it("keeps the shell's entries that are one", () => {
    expect(list.map((r) => r.id)).toEqual([1, 2]);
    expect(roundList("nope")).toEqual([]);
  });

  it("marks the building's card while its window not pinned is open", () => {
    expect(cardWindowOpen(list, "s1")).toBe(true);
    expect(cardWindowOpen(list.filter((r) => r.pinned), "s1")).toBe(false);
    expect(cardWindowOpen(list, "other")).toBe(false);
  });

  it("moves the composer only for a window of the building's own session", () => {
    expect(composerInWindow(list, "s1")).toBe(true);
    // A sub-session's window leaves the building's composer be.
    expect(composerInWindow(list.filter((r) => r.sessionId === "sub"), "s1")).toBe(false);
    expect(composerInWindow(list, "sub")).toBe(false);
  });

  it("reads what a window is asked to show from its address", () => {
    expect(parseRoundHash("#round?task=t&session=sub&tower=s1&item=i-9&title=3F+%C2%B7+%E6%A0%B8%E5%AF%B9&n=4")).toEqual({ taskId: "t", sessionId: "sub", towerFor: "s1", itemId: "i-9", title: "3F · 核对", nonce: "4" });
    expect(parseRoundHash("#round?task=t&session=s1")).toEqual({ taskId: "t", sessionId: "s1", towerFor: "s1", itemId: null, title: "", nonce: "" });
    expect(parseRoundHash("#round?session=s1")).toBeNull();
    expect(parseRoundHash("#plan?session=s1")).toBeNull();
  });

  it("takes 到对话里看 only with its task, session and building", () => {
    expect(roundChatTarget({ taskId: "t", sessionId: "s", towerFor: "s", itemId: "i" })).toEqual({ taskId: "t", sessionId: "s", towerFor: "s", itemId: "i" });
    expect(roundChatTarget({ taskId: "t", sessionId: "s", towerFor: "s", itemId: 3 })).toEqual({ taskId: "t", sessionId: "s", towerFor: "s" });
    expect(roundChatTarget({ taskId: "t", sessionId: "s" })).toBeNull();
  });
});
