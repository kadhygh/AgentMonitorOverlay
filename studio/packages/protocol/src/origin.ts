import type { MessageOrigin, MessageOriginKind } from "./entities.js";

// 交流框架 (2026-11-15, plans/collab-framework.md): a message an agent or Studio put into a session is told apart from
// the person's. New rows carry `origin`; rows from before (and the first message of a session another one opened,
// which goes in through the runtime as the person's do) only have the 【…】 line written for the model — read here, so
// conversations that were already under way look right too. The line's wording lives where it is written
// (sessions/service.ts, teamrelay/service.ts, relays/service.ts, collab/service.ts); origin.test.ts holds them together.

const SESSION = "「(.*?)」（([^（）\\s]+)）";
const HEADS: { kind: MessageOriginKind; re: RegExp; state?: MessageOrigin["state"]; from?: string }[] = [
  { kind: "team", re: /^【中转回复】\n/, from: "中转" },
  { kind: "report", re: new RegExp(`^【你开的会话${SESSION}这一轮做完了(?:，它已经用留言把结果发给你)?】\\n?`), state: "done" },
  { kind: "report", re: new RegExp(`^【你开的会话${SESSION}被人停下了，还没有结论】`), state: "stopped" },
  { kind: "report", re: new RegExp(`^【你开的会话${SESSION}出错停下了】\\n?`), state: "failed" },
  { kind: "send", re: new RegExp(`^【开启你的会话${SESSION}发来】\\n`) },
  { kind: "relay", re: /^【主控「(.*?)」传话】\n/ },
  { kind: "start", re: /^【由本任务的会话「(.*?)」开启】\n/ },
  { kind: "start", re: /^【本任务的会话「(.*?)」应人的要求开启：人会在这里和你一起推进】\n/ },
  { kind: "mail", re: /^\[AMO 留言\] 来自(.+?)：\n\n/ },
  // 协作 (2026-11-23, teamrelay/cowork.ts): 【协作「标题」· 程序老李 在群聊里 @ 了你】. The row's origin names the person.
  { kind: "cowork", re: /^【协作「(.*?)」·[^】\n]*】\n/ },
];

/**
 * Who a user row is from when it is not the person, and its text without the line that says so (`body`; the whole text
 * when the row has `origin` but no such line, as 值守's). null: the person's own message.
 */
export function messageOrigin(item: { text: string; origin?: MessageOrigin }): { origin: MessageOrigin; body: string } | null {
  for (const h of HEADS) {
    const m = h.re.exec(item.text);
    if (!m) continue;
    const read: MessageOrigin = { kind: h.kind, from: h.from ?? (m[1] || "未命名会话"), ...(h.kind !== "relay" && h.kind !== "start" && h.kind !== "mail" && h.kind !== "cowork" && m[2] ? { sessionId: m[2] } : {}), ...(h.state ? { state: h.state } : {}) };
    // A stored origin wins (it has what the line does not: the people who answered, the 中转 sessions); the line only
    // gives the body.
    return { origin: item.origin ?? read, body: item.text.slice(m[0].length) };
  }
  return item.origin ? { origin: item.origin, body: item.text } : null;
}

/** The head of such a row, as the conversation and the 事项 list word it. */
export function originLabel(origin: MessageOrigin): string {
  switch (origin.kind) {
    case "start":
      return `会话「${origin.from}」开启了这个会话`;
    case "report":
      return origin.state === "stopped" ? `子会话「${origin.from}」被人停下了` : origin.state === "failed" ? `子会话「${origin.from}」出错停下了` : `子会话「${origin.from}」回报`;
    case "send":
      return `会话「${origin.from}」发来`;
    case "team":
      return origin.from === "中转" ? "中转回复" : `${origin.from} 回复（中转）`;
    case "relay":
      return `主控「${origin.from}」传话`;
    case "mail":
      return `留言 · 来自${origin.from}`;
    case "duty":
      return `值守「${origin.from}」`;
    case "cowork":
      return origin.cowork ? `${origin.from} ${origin.cowork.where}（协作「${origin.cowork.title}」）` : `协作「${origin.from}」`;
  }
}
