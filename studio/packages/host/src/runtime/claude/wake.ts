import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import type { SessionWake } from "@amo-studio/protocol";

// What wakes a Claude session by itself (stage 15, 2026-10-16): the agent's /loop (ScheduleWakeup) and a claude.ai usage
// limit. The CLI keeps both timers in its own process, so Studio keeps that process while one is pending, and steps in
// itself only when the CLI has not gone on by then (or its process is gone, e.g. after a Host restart).

/** After a reset, how long the CLI gets to go on by itself before Studio sends the message. */
export const LIMIT_CONTINUE_GRACE_MS = 5 * 60_000;
/** A loop wakeup the CLI should have fired (its process alive) but has not, this long after its time. */
export const LOOP_LATE_MS = 5 * 60_000;
/** A wakeup Studio takes over after a Host restart, when its time has passed already. */
export const LOOP_AFTER_RESTART_MS = 60_000;
/** Studio starts a session's turn itself at most this often. */
export const WAKE_MIN_GAP_MS = 10 * 60_000;
/** A usage limit without auto-continue keeps the process this long after the reset (the CLI may go on by itself). */
export const LIMIT_KEEP_MS = 15 * 60_000;

/** The message Studio sends after a usage limit outside a loop. */
export const LIMIT_CONTINUE_TEXT = "额度已恢复（AMO Studio 自动发送）。请检查中断时的现场（包括被中断的子 agent），从中断的地方继续。";

/** The CLI's text for a turn stopped at a usage limit ("You've hit your session limit · resets 12:30am …"). */
export function isUsageLimitText(text: string): boolean {
  const t = text.trim();
  return USAGE_LIMIT_ERROR_PREFIXES.some((p) => t.startsWith(p));
}

/** A ScheduleWakeup call: the loop goes on at `at` (from the tool result, else now + the delay asked), or it stops. */
export function loopFromScheduleWakeup(
  input: Record<string, unknown>,
  result: unknown,
  now: Date,
): { stop: true } | { stop: false; loop: NonNullable<SessionWake["loop"]> } {
  if (input.stop === true) return { stop: true };
  const scheduledFor = (result as { scheduledFor?: unknown } | null | undefined)?.scheduledFor;
  const delay = typeof input.delaySeconds === "number" ? input.delaySeconds : 0;
  const at = typeof scheduledFor === "number" ? new Date(scheduledFor) : new Date(now.getTime() + Math.max(60, Math.min(3600, delay)) * 1000);
  return { stop: false, loop: { at: at.toISOString(), reason: typeof input.reason === "string" ? input.reason : "", prompt: typeof input.prompt === "string" ? input.prompt : "" } };
}

/**
 * When Studio itself should start the session's next turn, and with what; null = it waits (for the CLI, or the person).
 * `alive`: the session's Claude Code process is running (its own timers armed).
 */
export function studioWakeDue(wake: SessionWake | null | undefined, alive: boolean, now: Date): { at: number; text: string; why: "limit" | "loop" } | null {
  if (!wake) return null;
  if (wake.limit) {
    if (!wake.limit.autoContinue || !wake.limit.resetsAt) return null;
    const text = wake.loop?.prompt || LIMIT_CONTINUE_TEXT;
    return { at: Date.parse(wake.limit.resetsAt) + LIMIT_CONTINUE_GRACE_MS, text, why: "limit" };
  }
  if (wake.loop?.prompt) {
    const at = Date.parse(wake.loop.at);
    return { at: alive ? at + LOOP_LATE_MS : Math.max(at, now.getTime() + (at <= now.getTime() ? LOOP_AFTER_RESTART_MS : 0)), text: wake.loop.prompt, why: "loop" };
  }
  return null;
}

/** Whether the idle close must leave the process alone (its CLI still has a timer to fire). */
export function keepsProcess(wake: SessionWake | null | undefined, now: Date): boolean {
  if (!wake) return false;
  if (wake.limit) return !wake.limit.resetsAt || now.getTime() < Date.parse(wake.limit.resetsAt) + LIMIT_KEEP_MS;
  return !!wake.loop;
}

/**
 * The Agent call that started a background agent, from the CLI's own record of it
 * (`<config>/projects/<dir>/<session>/subagents/agent-<id>.meta.json`): an agent resumed with SendMessage after its
 * Claude Code process was closed is only known to Studio by that call.
 */
export function agentToolUseId(configDir: string, sessionRef: string, agentId: string): string | null {
  if (!/^[\w-]+$/.test(agentId)) return null;
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, sessionRef, "subagents", `agent-${agentId}.meta.json`);
    if (!existsSync(file)) continue;
    try {
      const id = (JSON.parse(readFileSync(file, "utf8")) as { toolUseId?: unknown }).toolUseId;
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}
