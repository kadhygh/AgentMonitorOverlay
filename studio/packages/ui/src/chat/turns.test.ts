import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { buildTranscript, closedTitle, foldable, formatDuration, formatTokens, liveTitle, outputSpeed, segmentWeight, sessionStats, turnLabel, windowStart, type ProcessMember } from "./turns.js";

let seq = 0;
const base = (turnId?: string) => ({ id: `i${++seq}`, sessionId: "s", seq, createdAt: "2026-10-13T00:00:00.000Z", ...(turnId ? { raw: { runtime: "codex" as const, method: "x", turnId } } : {}) });
const turn = (turnId: string, state: "running" | "completed" | "failed" | "interrupted" = "completed", seconds = 72): SessionItem => ({
  ...base(turnId),
  type: "turn",
  turnId,
  state,
  startedAt: "2026-10-13T00:00:00.000Z",
  ...(state === "running" ? {} : { endedAt: new Date(Date.parse("2026-10-13T00:00:00.000Z") + seconds * 1000).toISOString() }),
  usage: { input: 1000, cachedInput: 800, output: 200, reasoning: 50 },
});
const user = (text: string, t?: string): SessionItem => ({ ...base(t), type: "user", text });
const agent = (markdown: string, t?: string, streaming = false): SessionItem => ({ ...base(t), type: "agent", markdown, streaming });
const think = (text: string, t?: string, streaming = false): SessionItem => ({ ...base(t), type: "reasoning", text, streaming });
const tool = (kind: "read" | "command" | "edit" | "search", summary: string, t?: string, status: "running" | "completed" = "completed"): SessionItem => ({
  ...base(t),
  type: "tool",
  name: kind === "command" ? "shell" : kind,
  kind,
  summary,
  status,
});

describe("buildTranscript", () => {
  it("keeps CLI records in sight: compaction and command output at the end, no rows for background commands or suggestions", () => {
    const compaction: SessionItem = { ...base("t2"), type: "compaction", state: "completed", beforeTokens: 12000 };
    const output: SessionItem = { ...base("t3"), type: "command", name: "cost", output: "Total cost: $0" };
    const background: SessionItem = { ...base("t1"), type: "background", taskId: "b1", command: "npm run dev", state: "running", startedAt: "2026-10-13T00:00:00.000Z" };
    const suggestion: SessionItem = { ...base(), type: "suggestion", text: "再跑一遍测试" };
    const items = [turn("t1"), user("go", "t1"), tool("command", "npm run dev", "t1"), background, agent("", "t1"), agent("started", "t1"), suggestion, user("/compact"), turn("t2"), compaction, user("/cost"), turn("t3"), output];
    const segs = buildTranscript(items, false);
    expect(segs).toHaveLength(3);
    expect(segs[0]!.rows.flatMap((r) => (r.kind === "group" ? r.members : [r.item])).map((i) => i.type)).toEqual(["tool"]);
    expect(segs[0]!.answer).toMatchObject({ markdown: "started" });
    expect(segs[1]!.tail).toEqual([compaction]);
    expect(segs[1]!.rows).toEqual([]);
    expect(segs[2]!.tail).toEqual([output]);
  });

  it("splits a turn into the message, the work, the answer", () => {
    const items = [turn("t1"), user("加重试", "t1"), think("先读文件", "t1"), tool("read", "importer.py", "t1"), tool("command", "npm test", "t1"), agent("改好了", "t1")];
    const [seg] = buildTranscript(items, false);
    expect(seg!.inputs.map((i) => i.type)).toEqual(["user"]);
    expect(seg!.rows).toHaveLength(1);
    expect(seg!.rows[0]).toMatchObject({ kind: "group", closed: true });
    expect((seg!.rows[0] as { members: ProcessMember[] }).members.map((m) => m.type)).toEqual(["reasoning", "tool", "tool"]);
    expect(seg!.answer).toMatchObject({ markdown: "改好了" });
    expect(seg!.turn).toMatchObject({ turnId: "t1" });
    expect(foldable(seg!)).toBe(true);
  });

  it("starts a new segment at each message and at each new turn", () => {
    const items = [turn("t1"), user("a", "t1"), agent("A", "t1"), turn("t2"), user("b", "t2"), agent("B", "t2"), turn("t3"), agent("C (background)", "t3")];
    const segs = buildTranscript(items, false);
    expect(segs.map((s) => s.answer?.markdown)).toEqual(["A", "B", "C (background)"]);
    expect(segs.map((s) => s.inputs.length)).toEqual([1, 1, 0]);
  });

  it("splits sessions without turn records at the person's messages", () => {
    const segs = buildTranscript([user("a"), tool("command", "x"), agent("A"), user("b"), agent("B")], false);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.turn).toBeNull();
    expect(foldable(segs[0]!)).toBe(true);
    expect(segs[1]!.rows).toEqual([]);
  });

  it("keeps a reply between steps in the work, and lets it end the group before it", () => {
    const items = [turn("t1"), user("a", "t1"), tool("read", "x", "t1"), agent("看到了，接着改", "t1"), tool("edit", "x", "t1"), agent("done", "t1")];
    const [seg] = buildTranscript(items, false);
    expect(seg!.rows.map((r) => r.kind)).toEqual(["group", "item", "group"]);
    expect(seg!.answer?.markdown).toBe("done");
  });

  it("keeps the last group of a running turn open and does not fold it", () => {
    const items = [turn("t1", "running"), user("a", "t1"), think("…", "t1", true), tool("command", "npm test", "t1", "running")];
    const [seg] = buildTranscript(items, true);
    expect(seg!.running).toBe(true);
    expect(seg!.rows[0]).toMatchObject({ kind: "group", closed: false });
    expect(foldable(seg!)).toBe(false);
  });

  it("keeps the group open while the turn waits on an approval for it", () => {
    const pending: SessionItem = { ...base("t1"), type: "approval", approvalId: "1", kind: "command", summary: "cat x", state: "pending" };
    const [seg] = buildTranscript([turn("t1", "running"), user("a", "t1"), tool("read", "x", "t1", "running"), pending], true);
    expect(seg!.rows.map((r) => r.kind)).toEqual(["group", "item"]);
    expect(seg!.rows[0]).toMatchObject({ closed: false });
  });

  it("steering stays in its turn and stops the turn folding as one", () => {
    const items = [turn("t1"), user("a", "t1"), tool("read", "x", "t1"), user("顺便看下测试", "t1"), tool("command", "t", "t1"), agent("ok", "t1")];
    const segs = buildTranscript(items, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.interleaved).toBe(true);
    expect(foldable(segs[0]!)).toBe(false);
  });

  it("puts a pending approval on its own and answered ones inside the group; errors stay visible at the end", () => {
    const pending: SessionItem = { ...base("t1"), type: "approval", approvalId: "1", kind: "command", summary: "rm x", state: "pending" };
    const answered: SessionItem = { ...base("t1"), type: "approval", approvalId: "0", kind: "command", summary: "ls", state: "accepted" };
    const error: SessionItem = { ...base("t1"), type: "error", message: "boom" };
    const [seg] = buildTranscript([turn("t1", "failed"), user("a", "t1"), tool("command", "ls", "t1"), answered, tool("command", "rm x", "t1"), pending, error], false);
    expect(seg!.rows.map((r) => r.kind)).toEqual(["group", "item"]);
    expect((seg!.rows[0] as { members: ProcessMember[] }).members).toHaveLength(3);
    expect(seg!.tail.map((i) => i.type)).toEqual(["error"]);
    expect(foldable(seg!)).toBe(false);
  });

  it("drops thinking that ended empty", () => {
    const [seg] = buildTranscript([user("a"), think(""), agent("A")], false);
    expect(seg!.rows).toEqual([]);
  });
});

describe("titles", () => {
  const members = (...kinds: Array<"read" | "command" | "edit" | "search">) => kinds.map((k) => tool(k, k) as ProcessMember);

  it("names a finished group by its most frequent work", () => {
    expect(closedTitle([]).title).toBe("已完成分析");
    expect(closedTitle(members("read")).title).toBe("已读取文件");
    expect(closedTitle(members("read", "search")).title).toBe("已读取文件并搜索代码");
    expect(closedTitle(members("command", "read", "read")).title).toBe("已读取文件并执行了命令");
    expect(closedTitle(members("read", "command", "edit")).title).toBe("已读取文件，执行了命令，修改了文件");
    expect(closedTitle(members("read", "command", "edit", "search")).title).toBe("已读取文件，执行了命令，修改了文件等");
  });

  it("names a running group by what runs now", () => {
    expect(liveTitle([think("x", undefined, true) as ProcessMember])).toMatchObject({ title: "正在分析请求", detail: "" });
    expect(liveTitle([tool("read", "a.ts") as ProcessMember, tool("command", "npm test", undefined, "running") as ProcessMember])).toMatchObject({
      title: "正在运行命令",
      detail: "npm test",
    });
  });

  it("formats the fold line, durations and token counts", () => {
    expect(turnLabel(turn("t") as never)).toBe("已完成，用时 1分12秒");
    expect(turnLabel(turn("t", "failed") as never)).toBe("处理失败");
    expect(turnLabel(null)).toBe("已完成");
    expect(formatDuration(400)).toBe("1秒");
    expect(formatDuration(3_725_000)).toBe("1小时2分");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(9600)).toBe("9.6k");
    expect(formatTokens(25_400)).toBe("25k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  it("sums the session's statistics", () => {
    expect(sessionStats([turn("a"), turn("b"), tool("read", "x"), tool("command", "y")])).toEqual({ turns: 2, steps: 2, tokens: 2400, subTokens: 0, cacheHit: 80, context: null });
    // What subagents spent themselves, apart (2026-10-17).
    const sub = { id: "s", sessionId: "x", seq: 9, createdAt: "", type: "subagent" as const, childSessionId: "c", summary: "helper", usage: { input: 900, cachedInput: 0, output: 100, reasoning: 0 } };
    expect(sessionStats([turn("a"), sub]).subTokens).toBe(1000);
    // Context use comes from the latest turn that reported it.
    const withContext = (id: string, context: number, contextWindow?: number): SessionItem => {
      const t = turn(id) as Extract<SessionItem, { type: "turn" }>;
      return { ...t, usage: { ...t.usage!, context, ...(contextWindow ? { contextWindow } : {}) } };
    };
    expect(sessionStats([withContext("a", 20_000, 200_000), withContext("b", 170_000, 200_000)]).context).toEqual({ used: 170_000, window: 200_000, percent: 85 });
    expect(sessionStats([withContext("a", 5000)]).context).toEqual({ used: 5000, window: null, percent: null });
  });

  it("measures output speed over the model calls' generating time only (as DSH)", () => {
    // 400 tokens generated over 10 s in all (the turn itself took longer: first tokens, a command, an approval).
    const t = { ...(turn("t") as Extract<SessionItem, { type: "turn" }>), decode: { ms: 10_000, tokens: 400 } };
    expect(outputSpeed(t)).toBe(40);
    expect(outputSpeed({ ...t, decode: { ms: 100, tokens: 5 } })).toBeNull();
    expect(outputSpeed({ ...t, decode: { ms: 5000, tokens: 0 } })).toBeNull();
    // Turns recorded before the measure: no number rather than a wrong one.
    expect(outputSpeed(turn("t") as never)).toBeNull();
    expect(outputSpeed(undefined)).toBeNull();
  });
});

describe("the window drawn of a long session (2026-10-24)", () => {
  // 30 finished turns, each: the message, ten steps of work, the answer.
  const items = Array.from({ length: 30 }, (_, n) => {
    const t = `w${n}`;
    return [turn(t), user(`q${n}`, t), ...Array.from({ length: 10 }, (_, k) => tool("read", `f${k}.ts`, t)), agent(`a${n}`, t)];
  }).flat();
  const segs = buildTranscript(items, false);

  it("counts a turn's work only where it is drawn", () => {
    expect(segmentWeight(segs[0]!, false)).toBe(3);
    expect(segmentWeight(segs[0]!, true)).toBe(12);
  });

  it("starts back from the end while the turns fit, at least two, and never after the place kept", () => {
    // Folded work: all 30 turns (90) fit.
    expect(windowStart(segs, false)).toBe(0);
    // Unfolded: 12 each, 400 holds 33 → all; 100 holds 8.
    expect(windowStart(segs, true, segs.length, 100)).toBe(22);
    // Earlier ones, back from where the window starts.
    expect(windowStart(segs, true, 22, 100)).toBe(14);
    // Two turns even over the budget.
    expect(windowStart(segs, true, segs.length, 5)).toBe(28);
    // A place to go back to is kept in.
    expect(windowStart(segs, true, segs.length, 100, segs[3]!.key)).toBe(3);
    expect(windowStart([], true)).toBe(0);
  });
});
