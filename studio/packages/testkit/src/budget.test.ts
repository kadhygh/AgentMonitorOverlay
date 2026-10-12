import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetExceededError, DEFAULT_BUDGET_PATH, readBudget, reserveModelTurn } from "./budget.js";
import { removeTempDir } from "./temp.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) removeTempDir(dirs.pop()!);
});

function tempBudget(used: number, limit: number): string {
  const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-budget-"));
  dirs.push(dir);
  const path = join(dir, "budget.json");
  writeFileSync(path, JSON.stringify({ unit: "turn", providers: { deepseek: { limit, used }, glm: { limit: 1000, used: 0 } }, log: [] }));
  return path;
}

describe("reserveModelTurn", () => {
  it("increments the counter and appends a log entry", () => {
    const path = tempBudget(0, 100);
    const r = reserveModelTurn("deepseek", "S1-00 a", path, () => new Date("2026-10-12T00:00:00Z"));
    expect(r).toMatchObject({ used: 1, limit: 100, remaining: 99, low: false });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.providers.deepseek.used).toBe(1);
    expect(file.log).toEqual([{ at: "2026-10-12T00:00:00.000Z", provider: "deepseek", note: "S1-00 a" }]);
  });

  it("flags low budget below 20% remaining", () => {
    const path = tempBudget(80, 100);
    expect(reserveModelTurn("deepseek", "x", path).low).toBe(true);
  });

  it("throws without counting once the limit is reached", () => {
    const path = tempBudget(100, 100);
    expect(() => reserveModelTurn("deepseek", "x", path)).toThrow(BudgetExceededError);
    expect(JSON.parse(readFileSync(path, "utf8")).providers.deepseek.used).toBe(100);
  });

  it("resolves the default path to studio/budget.json", () => {
    expect(readBudget(DEFAULT_BUDGET_PATH).providers).toHaveProperty("deepseek");
  });
});
