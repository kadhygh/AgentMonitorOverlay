import { describe, expect, it } from "vitest";
import type { SessionItem } from "@amo-studio/protocol";
import { backgroundToShow, latestSuggestion } from "./ComposerExtras.js";
import { compactionLabel } from "./CliRows.js";

let seq = 0;
const base = () => ({ id: `i${++seq}`, sessionId: "s", seq, createdAt: "2026-10-14T00:00:00.000Z" });
const bg = (state: "running" | "completed", endedAt?: string): Extract<SessionItem, { type: "background" }> => ({
  ...base(),
  type: "background",
  taskId: `t${seq}`,
  command: "npm run dev",
  state,
  startedAt: "2026-10-14T00:00:00.000Z",
  ...(endedAt ? { endedAt } : {}),
});

describe("composer extras", () => {
  it("lists running background commands and the ones that ended in the last ten minutes, unless dismissed", () => {
    const now = Date.parse("2026-10-14T01:00:00.000Z");
    const running = bg("running");
    const recent = bg("completed", "2026-10-14T00:55:00.000Z");
    const old = bg("completed", "2026-10-14T00:40:00.000Z");
    expect(backgroundToShow([running, recent, old], now, new Set())).toEqual([running, recent]);
    expect(backgroundToShow([running, recent, old], now, new Set([recent.id]))).toEqual([running]);
  });

  it("offers the suggestion only while nothing came after it", () => {
    const suggestion: SessionItem = { ...base(), type: "suggestion", text: "再跑一遍测试" };
    const turn: SessionItem = { ...base(), type: "turn", turnId: "t", state: "completed", startedAt: "2026-10-14T00:00:00.000Z" };
    const user: SessionItem = { ...base(), type: "user", text: "好" };
    expect(latestSuggestion([suggestion, turn, bg("running")])).toBe("再跑一遍测试");
    expect(latestSuggestion([suggestion, user])).toBeNull();
    expect(latestSuggestion([])).toBeNull();
  });

  it("words a compaction by how it went", () => {
    const c = (patch: object) => ({ ...base(), type: "compaction" as const, state: "completed" as const, ...patch });
    expect(compactionLabel(c({ beforeTokens: 12_400 }))).toBe("上下文已压缩（之前约 12k tok）");
    expect(compactionLabel(c({ trigger: "auto", beforeTokens: 180_000 }))).toBe("上下文快满了，已自动压缩（之前约 180k tok）");
    expect(compactionLabel(c({}))).toBe("上下文已压缩");
    expect(compactionLabel(c({ state: "running" }))).toBe("正在压缩上下文…");
    expect(compactionLabel(c({ state: "failed", error: "summary too long" }))).toBe("上下文压缩失败：summary too long");
  });
});
