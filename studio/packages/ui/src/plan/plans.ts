import type { SessionItem } from "@amo-studio/protocol";
import type { QuestionItem } from "../chat/questions/flow.js";
import { readStored, writeStored } from "../lib/stored.js";

// The plan window's pieces that need no DOM (2026-11-09, plans/done/plan-review-window.md).

/** The plans Claude asked to have reviewed in this session, oldest first: 第 1 版, 第 2 版, … */
export const planVersions = (items: readonly SessionItem[]): QuestionItem[] => items.filter((i): i is QuestionItem => i.type === "question" && i.source === "plan-review");

/** The latest version: the one Claude waits on, if any, else the last. */
export function latestPlan(versions: readonly QuestionItem[]): QuestionItem | null {
  for (let i = versions.length - 1; i >= 0; i--) if (versions[i]!.state === "pending") return versions[i]!;
  return versions.at(-1) ?? null;
}

/** The version asked for, or the latest when none (or one this session does not have) was asked for. */
export function shownPlan(versions: readonly QuestionItem[], asked: string | null): QuestionItem | null {
  return (asked ? versions.find((v) => v.id === asked) : undefined) ?? latestPlan(versions);
}

/** The box's text for one version, kept across closing and opening the window until it is sent. */
export const planDraftKey = (itemId: string) => `amo-plan-draft:${itemId}`;
export const readPlanDraft = (itemId: string): string => readStored(planDraftKey(itemId)) ?? "";
export const writePlanDraft = (itemId: string, text: string): void => writeStored(planDraftKey(itemId), text ? text : null);
