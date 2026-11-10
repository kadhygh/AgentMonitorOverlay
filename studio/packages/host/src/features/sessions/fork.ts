import type { ForkTurn, SessionItem, SessionRuntime } from "@amo-studio/protocol";

// 分支 精确到每轮 (2026-11-10, plans/done/session-fork.md): which turns of a session can be forked through, and the items
// the new session starts with — the conversation through that turn, as the model will remember it.

type TurnItem = Extract<SessionItem, { type: "turn" }>;

/** Shown in the list: this many characters of the turn's message and of its reply. */
const EXCERPT = 80;

/** What a copy leaves out: what only the source's own process had (its suggestions, its background commands). */
const notCopied = (i: SessionItem) =>
  i.type === "suggestion" || i.type === "background" || ((i.type === "question" || i.type === "approval") && i.state === "pending");

/**
 * Where each turn's part of the item list ends (exclusive): at the next turn, less the person's messages just before it
 * that are not this turn's — they open the next one (Claude writes the message, then the turn starts; Codex's items say
 * their turn, and its endedAt is in whole seconds, so times cannot tell). The last turn runs to the end, less such
 * messages (still on their way).
 */
function cuts(items: readonly SessionItem[]): Array<{ turn: TurnItem; at: number; end: number }> {
  const at = items.flatMap((i, k) => (i.type === "turn" ? [k] : []));
  return at.map((k, n) => {
    const turn = items[k] as TurnItem;
    let end = at[n + 1] ?? items.length;
    while (end - 1 > k) {
      const it = items[end - 1]!;
      if (it.type !== "user" || it.raw?.turnId === turn.turnId) break;
      end--;
    }
    return { turn, at: k, end };
  });
}

const excerpt = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > EXCERPT ? `${one.slice(0, EXCERPT)}…` : one;
};

/** The session's turns, oldest first, with whether each can be forked through and why not. */
export function forkTurns(items: readonly SessionItem[], runtime: SessionRuntime): Array<ForkTurn & { forkPoint?: string }> {
  const spans = cuts(items);
  return spans.map(({ turn, end }, n) => {
    const from = n ? spans[n - 1]!.end : 0;
    const part = items.slice(from, end);
    const prompt = part.find((i) => i.type === "user" && i.text.trim());
    const reply = [...part].reverse().find((i) => i.type === "agent" && i.markdown.trim());
    const latest = n === spans.length - 1;
    const why =
      runtime === "dsh"
        ? "DeepSeek 会话不能分支：DSH 不支持"
        : turn.state === "running"
          ? "这一轮还在跑，等它结束再分支"
          : runtime === "claude" && !turn.forkPoint && !latest
            ? "这一轮是 Studio 开始记录分支位置之前跑的，只能从最新一轮分支"
            : undefined;
    return {
      turnId: turn.turnId,
      n: n + 1,
      state: turn.state,
      ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
      prompt: prompt?.type === "user" ? excerpt(prompt.text) : "",
      reply: reply?.type === "agent" ? excerpt(reply.markdown) : "",
      forkable: !why,
      ...(why ? { why } : {}),
      ...(turn.forkPoint ? { forkPoint: turn.forkPoint } : {}),
    };
  });
}

/** The items a session forked through this turn starts with (all of them when the session has no turns). */
export function itemsThrough(items: readonly SessionItem[], turnId: string | undefined): SessionItem[] {
  const span = turnId ? cuts(items).find((c) => c.turn.turnId === turnId) : undefined;
  return items.slice(0, span ? span.end : items.length).filter((i) => !notCopied(i));
}
