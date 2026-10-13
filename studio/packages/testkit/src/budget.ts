import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Counts real model turns against studio/budget.json (LOOP_RULES section 4).
// Call reserveModelTurn() before every real turn/start or SDK query turn.

/** gpt and claude are the person's own subscriptions (Codex default login, Claude subscription token). */
export type BudgetProvider = "deepseek" | "glm" | "gpt" | "claude";

export interface BudgetFile {
  unit: string;
  providers: Record<string, { limit: number; used: number }>;
  log: BudgetLogEntry[];
}

export interface BudgetLogEntry {
  at: string;
  provider: string;
  note: string;
}

export interface BudgetReservation {
  provider: BudgetProvider;
  used: number;
  limit: number;
  remaining: number;
  /** True once less than 20% of the limit is left; LOOP_RULES asks for a NEEDS_YOU entry then. */
  low: boolean;
}

export class BudgetExceededError extends Error {
  constructor(provider: string, used: number, limit: number) {
    super(`model budget exhausted for ${provider}: ${used}/${limit}`);
    this.name = "BudgetExceededError";
  }
}

const LOW_RATIO = 0.2;

// src/ and dist/ sit at the same depth, so this resolves to studio/budget.json from both.
export const DEFAULT_BUDGET_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "budget.json");

export function readBudget(path: string = DEFAULT_BUDGET_PATH): BudgetFile {
  return JSON.parse(readFileSync(path, "utf8")) as BudgetFile;
}

export function reserveModelTurn(
  provider: BudgetProvider,
  note: string,
  path: string = DEFAULT_BUDGET_PATH,
  now: () => Date = () => new Date(),
): BudgetReservation {
  const budget = readBudget(path);
  const entry = budget.providers[provider];
  if (!entry) throw new Error(`unknown budget provider: ${provider}`);
  if (entry.used >= entry.limit) throw new BudgetExceededError(provider, entry.used, entry.limit);

  entry.used += 1;
  budget.log.push({ at: now().toISOString(), provider, note });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(budget, null, 2) + "\n", "utf8");
  renameSync(tmp, path);

  const remaining = entry.limit - entry.used;
  return { provider, used: entry.used, limit: entry.limit, remaining, low: remaining < entry.limit * LOW_RATIO };
}
