import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { buildTranscript, closedTitle, foldable, formatDuration, formatTokens, liveTitle, outputSpeed, sessionStats, turnLabel, type ProcessMember } from "./turns.js";

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
    expect(sessionStats([turn("a"), turn("b"), tool("read", "x"), tool("command", "y")])).toEqual({ turns: 2, steps: 2, tokens: 2400, cacheHit: 80, context: null });
    // Context use comes from the latest turn that reported it.
    const withContext = (id: string, context: number, contextWindow?: number): SessionItem => {
      const t = turn(id) as Extract<SessionItem, { type: "turn" }>;
      return { ...t, usage: { ...t.usage!, context, ...(contextWindow ? { contextWindow } : {}) } };
    };
    expect(sessionStats([withContext("a", 20_000, 200_000), withContext("b", 170_000, 200_000)]).context).toEqual({ used: 170_000, window: 200_000, percent: 85 });
    expect(sessionStats([withContext("a", 5000)]).context).toEqual({ used: 5000, window: null, percent: null });
  });

  it("measures output speed without the time tools ran", () => {
    // 200 output tokens over 72 s, of which a command ran 62 s: 10 s of generating, 20 tok/s.
    const cmd = { ...(tool("command", "npm test") as Extract<SessionItem, { type: "tool" }>), durationMs: 62_000 };
    expect(outputSpeed(turn("t") as never, [cmd])).toBe(20);
    expect(outputSpeed(turn("t") as never, [])).toBe(3);
    expect(outputSpeed(turn("t", "completed", 0) as never, [])).toBeNull();
    expect(outputSpeed(undefined, [])).toBeNull();
  });
});
