import { describe, expect, it } from "vitest";
import type { TokenStats, TokenStatsDay } from "@amo-studio/protocol";
import { byDate, columns, fmtTokens, niceMax, rangeStart, statModels, sumRange, value } from "./statsData.js";

// 设置 → 统计 (2026-10-27).

const day = (date: string, profileId: string, input: number, cached = 0, output = 0, turns = 1): TokenStatsDay => ({ date, profileId, input, cached, output, turns });
function stats(days: TokenStatsDay[]): TokenStats {
  const ids = [...new Set(days.map((d) => d.profileId))];
  return { generatedAt: "2026-10-27T12:00:00.000Z", ms: 1, turns: days.length, days, models: ids.map((id) => ({ profileId: id, label: id.toUpperCase(), runtime: "codex", model: id === "a" ? "m-a" : null, removed: false })) };
}

describe("token stats in 设置", () => {
  it("colours the models most used first, keeps six, and folds the rest into 其他", () => {
    const s = stats([day("2026-10-01", "a", 10), day("2026-10-01", "b", 70), ...["c", "d", "e", "f", "g", "h"].map((id, i) => day("2026-10-02", id, 60 - i))]);
    const models = statModels(s);
    expect(models.map((m) => [m.id, m.color])).toEqual([
      ["b", "var(--stat-s1)"], ["c", "var(--stat-s2)"], ["d", "var(--stat-s3)"], ["e", "var(--stat-s4)"], ["f", "var(--stat-s5)"], ["g", "var(--stat-s6)"], ["other", "var(--stat-other)"],
    ]);
    expect(models.at(-1)!.profileIds.sort()).toEqual(["a", "h"]);
    // 其他 adds its models up.
    const data = byDate(s, models);
    expect(value(data.get("2026-10-01")!.get("other"), "all")).toBe(10);
    expect(statModels(stats([day("2026-10-01", "a", 1)]))[0]!.sub).toBe("Codex · m-a");
  });

  it("cuts days, weeks from Monday and months up to today, the current one marked as under way", () => {
    const s = stats([day("2026-10-27", "a", 5, 3, 1), day("2026-10-26", "a", 10), day("2026-10-25", "a", 100), day("2026-09-30", "a", 1000), day("2025-11-15", "a", 7)]);
    const models = statModels(s);
    const data = byDate(s, models);
    const today = new Date(2026, 9, 27, 15);
    const days = columns(data, "day", today);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toMatchObject({ key: "2026-10-27", partial: true, full: "10月27日 周二" });
    expect(value(days.at(-1)!.values.a, "all")).toBe(9);
    const weeks = columns(data, "week", today);
    expect(weeks).toHaveLength(12);
    expect(weeks.at(-1)).toMatchObject({ key: "2026-10-26", partial: true });
    expect(value(weeks.at(-1)!.values.a, "input")).toBe(15); // Monday 26 and today
    expect(value(weeks.at(-2)!.values.a, "input")).toBe(100); // Sunday 25 ends the week before
    const months = columns(data, "month", today);
    expect(months.map((m) => m.label)).toEqual(["11月", "12月", "2026年1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月"]);
    expect(value(months[0]!.values.a, "all")).toBe(7);
    expect(value(months.at(-2)!.values.a, "all")).toBe(1000);
    expect(rangeStart("week", today, data)).toBe("2026-08-10");
    expect(rangeStart("total", today, data)).toBe("2025-11-15");
    expect(sumRange(data, ["a"], "2026-10-26", "2026-10-27").total).toEqual({ input: 15, cached: 3, output: 1, turns: 2 });
  });

  it("writes tokens in 万 and 亿, and picks round axis tops", () => {
    expect([fmtTokens(960), fmtTokens(82_000), fmtTokens(3_861_000), fmtTokens(45_600_000), fmtTokens(99_996_000), fmtTokens(131_000_000), fmtTokens(18_700_000_000)]).toEqual([
      "960", "8.2 万", "386 万", "4,560 万", "1.00 亿", "1.31 亿", "187 亿",
    ]);
    expect([niceMax(0), niceMax(1.31e8), niceMax(2.3e9), niceMax(7)]).toEqual([1, 1.6e8, 2.4e9, 8]);
  });
});
