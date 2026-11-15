import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { buildTranscript } from "./turns.js";
import { nextUnreviewed, reviewControls, reviewKey, reviewKeys, reviewReasons, reviewUpTo, stateOf, unreviewed } from "./reviewLogic.js";

// 审阅进度 (2026-11-16): which reply a round is reviewed by, which show their 审过 button, what 复盘 counts.

let seq = 0;
const base = (turnId: string) => ({ id: `i${++seq}`, sessionId: "s", seq, createdAt: "2026-11-16T00:00:00.000Z", raw: { runtime: "codex" as const, method: "x", turnId } });
const turn = (turnId: string, state: "running" | "completed" = "completed"): SessionItem => ({ ...base(turnId), type: "turn", turnId, state, startedAt: "2026-11-16T00:00:00.000Z" });
const user = (text: string, t: string): SessionItem => ({ ...base(t), type: "user", text });
const agent = (markdown: string, t: string, streaming = false): SessionItem => ({ ...base(t), type: "agent", markdown, streaming });
const tool = (t: string, name: string, extra: Record<string, unknown> = {}): SessionItem => ({ ...base(t), type: "tool", name, summary: name, status: "completed", ...extra }) as SessionItem;

describe("审阅进度 in the conversation", () => {
  it("keys a round by its final reply, once it is done; a round still running or without a reply has none", () => {
    const done = agent("改好了", "t1");
    const between = agent("先看一下", "t1");
    const items = [turn("t1"), user("改一下", "t1"), between, tool("t1", "shell"), done, turn("t2", "running"), user("再来", "t2"), agent("正在写", "t2", true)];
    const segs = buildTranscript(items, true);
    expect(segs.map(reviewKey)).toEqual([done.id, null]);
    expect(reviewKeys(segs)).toEqual([done.id]);
    // An empty reply has nothing to review.
    expect(reviewKeys(buildTranscript([turn("t3"), user("嗯", "t3"), agent("  ", "t3")], false))).toEqual([]);
  });

  it("says why a short reply is still worth a 审过: approvals, questions, file changes, 查看包", () => {
    const plain = buildTranscript([turn("a"), user("问", "a"), tool("a", "shell"), agent("答", "a")], false)[0]!;
    expect(reviewReasons(plain)).toEqual([]);
    const busy = buildTranscript(
      [
        turn("b"),
        user("做", "b"),
        { ...base("b"), type: "approval", approvalId: "ap1", kind: "command", summary: "rm", state: "accepted" } as SessionItem,
        tool("b", "edit", { kind: "edit", files: [{ path: "a.ts", change: "modify", added: 1, removed: 0 }] }),
        tool("b", "mcp__amo__decision_request"),
        tool("b", "mcp__amo__view_open"),
        agent("好了", "b"),
      ],
      false,
    )[0]!;
    expect(reviewReasons(busy)).toEqual(["审批", "提问", "文件改动", "查看包"]);
  });

  it("stays quiet off 复盘: a button only on replies worth it, a tick on 审过 ones; in 复盘 everything", () => {
    expect(reviewControls({ mode: false, weighty: false, state: "unseen" })).toEqual({ toggle: false, label: false, upTo: false });
    expect(reviewControls({ mode: false, weighty: false, state: "seen" })).toEqual({ toggle: false, label: false, upTo: false });
    expect(reviewControls({ mode: false, weighty: true, state: "seen" })).toEqual({ toggle: true, label: false, upTo: false });
    expect(reviewControls({ mode: false, weighty: false, state: "reviewed" })).toEqual({ toggle: true, label: false, upTo: false });
    expect(reviewControls({ mode: true, weighty: false, state: "unseen" })).toEqual({ toggle: true, label: true, upTo: true });
    expect(reviewControls({ mode: true, weighty: false, state: "reviewed" })).toEqual({ toggle: true, label: false, upTo: true });
  });

  it("counts what is not 审过, marks up to a reply, and finds the next one below the place read", () => {
    const keys = ["a", "b", "c", "d"];
    const marks = { a: "reviewed", b: "seen" } as const;
    expect(["a", "b", "c", "x"].map((k) => stateOf(marks, k))).toEqual(["reviewed", "seen", "unseen", "unseen"]);
    expect(unreviewed(keys, marks)).toEqual(["b", "c", "d"]);
    expect(reviewUpTo(keys, marks, "c")).toEqual(["b", "c"]);
    expect(reviewUpTo(keys, marks, "gone")).toEqual([]);
    expect(nextUnreviewed(keys, marks, null)).toBe("b");
    expect(nextUnreviewed(keys, marks, "b")).toBe("c");
    // Past the last one: from the start again.
    expect(nextUnreviewed(keys, marks, "d")).toBe("b");
    expect(nextUnreviewed(keys, { a: "reviewed", b: "reviewed", c: "reviewed", d: "reviewed" }, null)).toBeNull();
  });
});
