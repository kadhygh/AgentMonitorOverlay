import { describe, expect, it } from "vitest";
import type { Cowork, CoworkInboxItem, Message, Thread } from "@amo-studio/relay/light";
import { clippedMessageText, COWORK_BRIEF, deliveryText, messageLine, messagesSection, pickByBudget, sessionText } from "./cowork-text.js";

// 协作里给 AI 看的内容要精简 (2026-11-23, 中转迭代讨论): the budgets of cowork-text.ts on made-up messages.

const ME = "studio:d1:s-me";
const cowork = {
  id: "cw1",
  title: "射速",
  goal: "上限可配",
  repo: "",
  branch: "",
  members: ["策划小王", "程序老李"],
  agents: [{ mark: ME, name: "策划小王 的 AI · 射速", owner: "策划小王", state: "idle", queued: 0 }],
  sessions: [{ id: "sub1", title: "存哪", from: "策划小王", to: "程序老李", state: "open", agent: ME, updatedAt: 0 }],
  options: { aiInitiate: false },
  endedAt: null,
} as unknown as Cowork;

let seq = 100;
const msg = (body: string, o: Partial<Message> = {}): Message => ({ id: `m${++seq}`, threadId: "cw1", seq, author: "程序老李", via: { kind: "person" }, kind: "text", body, createdAt: 1_700_000_000_000, ...o }) as Message;
const long = (n: number, word = "射速") => word.repeat(Math.ceil(n / word.length)).slice(0, n);

describe("协作的精简", () => {
  it("a long message is cut after its head and says where the whole is; a short one and an event stay whole", () => {
    const m = msg(`${long(800)}尾巴`);
    const cut = clippedMessageText(m, cowork, 500);
    expect(cut).toContain(`### 程序老李 · 群聊`);
    expect(cut).toContain(`#${m.seq}`);
    expect(cut).not.toContain("尾巴");
    expect(cut).toContain(`截到 500 字，全文看 #${m.seq}：cowork_read 带 seq ${m.seq}`);
    const short = msg("行。");
    expect(clippedMessageText(short, cowork, 500)).not.toContain("截到");
    const ev = msg(long(900), { kind: "event" });
    expect(clippedMessageText(ev, cowork, 500)).not.toContain("截到");
  });

  it("one line: #seq · who · where · its first sentence, at most lineChars", () => {
    expect(messageLine(msg("上限放配置表。其余的以后再说。", { threadId: "sub1" }), cowork)).toMatch(/^- #\d+ 程序老李 · 子会话「存哪」 · 上限放配置表。$/);
    const line = messageLine(msg(long(300)), cowork);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(COWORK_BRIEF.lineChars + 40);
    expect(messageLine(msg("", { kind: "reply", answers: [{ questionId: "q1", choice: "行" }] } as Partial<Message>), cowork)).toContain("（回答了提问）");
  });

  it("cowork_read's messages: within readChars from the newest back, the agent's own whole wherever they are, others cut, older ones one line, past lineMax only counted", () => {
    const B = COWORK_BRIEF;
    const forMeLong = msg(`${long(2000)}给你的尾巴`, { agentMentions: [ME] });
    const older = Array.from({ length: 60 }, (_, i) => msg(`${i} 号。${long(450)}`));
    const newer = Array.from({ length: 20 }, (_, i) => msg(`新 ${i} 号。${long(900)}别人的尾巴`));
    const all = [forMeLong, ...older, ...newer];
    const s = messagesSection(all, cowork, (m) => m.id === forMeLong.id);
    // The @ is whole even though it is the oldest; the newest others are cut, not whole.
    expect(s.text).toContain("给你的尾巴");
    expect(s.text).not.toContain("别人的尾巴");
    expect(s.text).toContain(`截到 ${B.clipChars} 字`);
    // Everything but the agent's own within the budget.
    const blocks = s.text.split("\n\n").filter((b) => !b.startsWith("- #") && !b.includes("给你的尾巴"));
    expect(blocks.join("\n\n").length).toBeLessThanOrEqual(B.readChars + 200);
    // Then one line each, at most lineMax; the rest counted.
    const lines = s.text.split("\n").filter((l) => l.startsWith("- #"));
    expect(lines).toHaveLength(B.lineMax);
    expect(s.dropped).toBe(all.length - s.full.length - B.lineMax);
    expect(s.full.map((m) => m.id)).toContain(forMeLong.id);
    // Oldest first: the line entries come before the newest blocks.
    expect(s.text.indexOf("- #")).toBeLessThan(s.text.indexOf(`新 ${newer.length - 1} 号`));
    // Paging back starts at the oldest one-line entry (the dropped ones are older), not at the older @ shown whole.
    expect(s.oldest).toBe(Number(lines[0]!.slice(3).split(" ")[0]));
    expect(s.oldest).toBeGreaterThan(forMeLong.seq);
  });

  it("pickByBudget: once one does not fit, the older ones are lines (no gaps filled); clip null tries whole, then cut", () => {
    const ms = [msg("a"), msg("b"), msg("c"), msg("d")];
    const sizes: Record<string, number> = { a: 10, b: 10, c: 100, d: 30 };
    const out = pickByBudget(ms, { budget: 50, whole: () => false, clip: 999, size: (m) => sizes[m.body]! });
    expect(out.shown.map((x) => `${x.m.body}:${x.how}`)).toEqual(["a:line", "b:line", "c:line", "d:clip"]);
    const tried = pickByBudget([msg("x")], { budget: 50, whole: () => false, clip: null, size: (_m, how) => (how === "full" ? 80 : 40) });
    expect(tried.shown[0]!.how).toBe("clip");
  });

  it("an @'s delivery: the 前文 cut to contextChars, oldest first, then the @ whole", () => {
    const replied = msg(`${long(700)}被回的尾巴`);
    const before = [msg("前一条。"), msg(`${long(600)}前文尾巴`)];
    const at = msg(`${long(1500)}艾特尾巴`, { agentMentions: [ME], replyTo: replied.seq });
    const item = { delivery: { id: "d1", reason: "mention" }, thread: { id: "cw1", kind: "cowork", title: "射速" }, message: at, cowork } as unknown as CoworkInboxItem;
    const text = deliveryText({ items: [item], cowork, me: "策划小王", myName: "策划小王 的 AI · 射速", mark: ME, unread: 4, lines: [], context: [replied, ...before, at] });
    expect(text).toContain(`前文（每条截到 ${COWORK_BRIEF.contextChars} 字`);
    expect(text).not.toContain("被回的尾巴");
    expect(text).not.toContain("前文尾巴");
    expect(text).toContain("前一条。");
    expect(text).toContain("艾特尾巴");
    expect(text.indexOf(`#${replied.seq}`)).toBeLessThan(text.indexOf("前一条。"));
    expect(text.indexOf("给你的：")).toBeLessThan(text.indexOf("艾特尾巴"));
    // The @ is not repeated as its own 前文; the rest is only counted.
    expect(text.split("艾特尾巴")).toHaveLength(2);
    expect(text).toContain("另有 4 条");
  });

  it("a 子会话: its opening question whole however long, the rest within sessionChars, the agent's own whole, older ones one line with how to page back", () => {
    const B = COWORK_BRIEF;
    const opening = msg(`${long(8000)}提问尾巴`, { threadId: "sub1", kind: "request", via: { kind: "ai", conv: ME } } as Partial<Message>);
    const answer = msg(`${long(1200)}回你的尾巴`, { threadId: "sub1", replyTo: opening.seq });
    const talk = Array.from({ length: 50 }, (_, i) => msg(`第 ${i} 句。${long(300)}`, { threadId: "sub1" }));
    const thread = { id: "sub1", title: "存哪", kind: "request", request: null } as unknown as Thread;
    const out = sessionText(thread, [opening, answer, ...talk], cowork, ME, (m) => m.id === answer.id);
    expect(out.text).toContain("提问尾巴");
    expect(out.text).toContain("回你的尾巴");
    expect(out.text).toContain(`第 ${talk.length - 1} 句。`);
    expect(out.text).toMatch(/\n- #\d+ 程序老李 · 子会话「存哪」 · 第 \d+ 句。/);
    expect(out.text).toContain("只列一行的，要看全文用 cowork_read 带 seq");
    const body = out.text.split("\n\n").filter((b) => !b.startsWith("- #") && !b.includes("提问尾巴") && !b.includes("回你的尾巴") && b.startsWith("### "));
    expect(body.join("\n\n").length).toBeLessThanOrEqual(B.sessionChars);
    expect(out.seen.map((m) => m.id)).toEqual(expect.arrayContaining([opening.id, answer.id]));
  });
});
