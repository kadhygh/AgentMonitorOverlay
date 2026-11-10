import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { forkTurns, itemsThrough } from "./fork.js";

let seq = 0;
const at = (m: number) => `2026-11-10T10:${String(m).padStart(2, "0")}:00.000Z`;
const user = (m: number, text: string): SessionItem => ({ id: `i${++seq}`, sessionId: "s", seq, createdAt: at(m), type: "user", text });
const agent = (m: number, markdown: string): SessionItem => ({ id: `i${++seq}`, sessionId: "s", seq, createdAt: at(m), type: "agent", markdown, streaming: false });
const turn = (m: number, turnId: string, end: number | null, forkPoint?: string): SessionItem => ({
  id: `i${++seq}`, sessionId: "s", seq, createdAt: at(m), type: "turn", turnId, startedAt: at(m), state: end === null ? "running" : "completed", ...(end === null ? {} : { endedAt: at(end) }), ...(forkPoint ? { forkPoint } : {}),
});

describe("分支 精确到每轮 (2026-11-10)", () => {
  // Claude's order: the person's message, then the turn item once the model starts.
  const items = [
    user(0, "把登录页的报错改成中文"), turn(0, "t1", 2, "u1"), agent(1, "改好了"),
    user(3, "再加个记住密码"), turn(3, "t2", 5, "u2"), agent(4, "加了"), { id: "sg", sessionId: "s", seq: ++seq, createdAt: at(5), type: "suggestion", text: "提交吧" } as SessionItem,
    user(6, "提交吧"), turn(6, "t3", null),
  ];

  it("lists each turn with its message, its reply and whether it can be forked through", () => {
    expect(forkTurns(items, "claude")).toMatchObject([
      { turnId: "t1", n: 1, prompt: "把登录页的报错改成中文", reply: "改好了", forkable: true, forkPoint: "u1" },
      { turnId: "t2", n: 2, prompt: "再加个记住密码", reply: "加了", forkable: true },
      { turnId: "t3", n: 3, prompt: "提交吧", reply: "", forkable: false, why: "这一轮还在跑，等它结束再分支" },
    ]);
  });

  it("copies the conversation through the turn: not the next turn's message, nor the source's suggestions", () => {
    expect(itemsThrough(items, "t1").map((i) => i.type === "user" ? i.text : i.type === "agent" ? i.markdown : i.type)).toEqual(["把登录页的报错改成中文", "turn", "改好了"]);
    expect(itemsThrough(items, "t2").map((i) => i.type)).toEqual(["user", "turn", "agent", "user", "turn", "agent"]);
  });

  it("Claude turns from before fork points: only the latest can be forked; DSH none", () => {
    const old = [user(0, "a"), turn(0, "t1", 1), agent(1, "A"), user(2, "b"), turn(2, "t2", 3), agent(3, "B")];
    expect(forkTurns(old, "claude").map((t) => t.forkable)).toEqual([false, true]);
    expect(forkTurns(old, "codex").map((t) => t.forkable)).toEqual([true, true]);
    expect(forkTurns(old, "dsh").every((t) => !t.forkable)).toBe(true);
  });

  it("Codex's order (the message inside its turn, endedAt in whole seconds before its items) splits the same way", () => {
    const of = (i: SessionItem, turnId: string): SessionItem => ({ ...i, raw: { runtime: "codex", method: "item/completed", turnId } });
    // As seen in the e2e: the turn's endedAt (…:39.000Z) is earlier than its message (…:39.238Z).
    const codex = [turn(1, "c1", 0), of(user(1, "first"), "c1"), of(agent(1, "one"), "c1"), turn(3, "c2", 2), of(user(3, "second"), "c2"), of(agent(3, "two"), "c2")];
    expect(forkTurns(codex, "codex").map((t) => [t.prompt, t.reply])).toEqual([["first", "one"], ["second", "two"]]);
    expect(itemsThrough(codex, "c1")).toHaveLength(3);
  });
});
