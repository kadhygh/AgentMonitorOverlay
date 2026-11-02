import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { unansweredPrompt } from "./takeBack.js";

const base = { sessionId: "s", createdAt: "2026-10-28T00:00:00.000Z" };
let n = 0;
const item = (x: Record<string, unknown>) => ({ ...base, id: `i${n++}`, ...x }) as SessionItem;

describe("停止 right after sending", () => {
  it("gives the message back while nothing has answered it, thinking aside", () => {
    const sent = item({ type: "user", text: "改一下掉落表" });
    expect(unansweredPrompt([sent])).toBe("改一下掉落表");
    expect(unansweredPrompt([item({ type: "turn", turnId: "t", state: "running", startedAt: base.createdAt }), sent, item({ type: "reasoning", text: "…" }), item({ type: "agent", markdown: "", streaming: true })])).toBe("改一下掉落表");
  });

  it("keeps it once a reply, a tool call or a question came back, or with no message at all", () => {
    const sent = item({ type: "user", text: "改一下掉落表" });
    expect(unansweredPrompt([sent, item({ type: "agent", markdown: "好" })])).toBeNull();
    expect(unansweredPrompt([sent, item({ type: "tool", name: "Bash", summary: "ls", status: "running" })])).toBeNull();
    expect(unansweredPrompt([sent, item({ type: "question", state: "pending" })])).toBeNull();
    expect(unansweredPrompt([item({ type: "agent", markdown: "你好" })])).toBeNull();
    expect(unansweredPrompt([])).toBeNull();
  });

  it("leaves a message still waiting where it is: it goes to the model after the stop anyway (立即发送, 2026-11-02)", () => {
    expect(unansweredPrompt([item({ type: "agent", markdown: "在改" }), item({ type: "user", text: "顺便看下日志", delivery: "waiting" })])).toBeNull();
    expect(unansweredPrompt([item({ type: "user", text: "没送到的", delivery: "unsent" })])).toBe("没送到的");
  });
});
