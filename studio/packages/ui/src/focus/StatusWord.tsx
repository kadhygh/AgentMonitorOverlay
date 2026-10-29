import type { SessionStatus } from "@amo-studio/protocol";

// Focus in the main window's look (2026-10-29 evening, the user: version A of out/html/focus-design.html, every row
// starting with a status word as in C, the entries as B's cards). The status word says what a row is in a mark and a
// word — the mark so it never rests on colour alone — and its tone colours the word and the card's left bar.

export type Tone = "att" | "run" | "wait" | "done" | "bad";

const MARK: Record<Tone, string> = { att: "!", run: "◐", wait: "○", done: "✓", bad: "!" };

/** A session's tone and word (完成待审核 is `done`, 等子 agent `run` with 等待). */
export function sessionWord(status: SessionStatus, opts: { toReview?: boolean; waitsSubs?: boolean } = {}): { tone: Tone; word: string } {
  if (opts.toReview) return { tone: "done", word: "完成" };
  if (opts.waitsSubs) return { tone: "run", word: "等待" };
  switch (status) {
    case "awaiting-approval":
      return { tone: "att", word: "批准" };
    case "awaiting-answer":
      return { tone: "att", word: "回答" };
    case "awaiting-review":
      return { tone: "att", word: "审阅" };
    case "running":
      return { tone: "run", word: "运行" };
    case "error":
      return { tone: "bad", word: "出错" };
    case "interrupted":
      return { tone: "bad", word: "中断" };
    case "completed":
      return { tone: "wait", word: "完成" };
    default:
      return { tone: "wait", word: "空闲" };
  }
}

export function StatusWord({ tone, word }: { tone: Tone; word?: string }) {
  return (
    <span className={`focus-st ${tone}`} data-testid="focus-status-word">
      <span className="focus-st-mark" aria-hidden="true">
        {MARK[tone]}
      </span>
      {word}
    </span>
  );
}
