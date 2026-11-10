import type { Id, TokenStats, TokenStatsDay, TokenStatsModel, TokenStatsRange } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";

/** YYYY-MM-DD of a time in the Host's time zone (the person's: Studio runs on their machine). */
export function localDate(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Usage = Omit<TokenStatsDay, "date">;

/**
 * 设置 → 统计 (2026-10-27): tokens per day and model, counted from scratch each time the page opens (or 重新统计). Every
 * turn of every session counts once — subagents and delegated sessions have their own turns, under their own model —
 * and nothing is stored: the turns are the record.
 */
export class StatsFeature extends Feature {
  tokens(): TokenStats {
    const started = performance.now();
    const days = new Map<string, TokenStatsDay>();
    let turns = 0;
    this.eachTurn((t, date) => {
      const key = `${date}|${t.profileId}`;
      let day = days.get(key);
      if (!day) days.set(key, (day = { date, ...empty(t.profileId) }));
      add(day, t);
      turns += 1;
    });
    return {
      generatedAt: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
      turns,
      days: [...days.values()].sort((a, b) => (a.date === b.date ? a.profileId.localeCompare(b.profileId) : a.date < b.date ? -1 : 1)),
      models: this.modelsOf(days.values()),
    };
  }

  /**
   * 按时间段查 (2026-11-10, the user: 统计里面加日期时间选择，可以列出指定日期时间的数据统计): the turns that started in
   * [from, to), per model — to the minute, where the charts go by day.
   */
  tokensBetween(from: unknown, to: unknown): TokenStatsRange {
    const started = performance.now();
    const a = typeof from === "string" ? new Date(from) : null;
    const b = typeof to === "string" ? new Date(to) : null;
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new HostError("bad_request", "from 和 to 要写成时间，例如 2026-11-10T08:00:00+08:00");
    if (a.getTime() >= b.getTime()) throw new HostError("bad_request", "开始时间要早于结束时间");
    const rows = new Map<Id, Usage>();
    let turns = 0;
    this.eachTurn((t) => {
      const at = new Date(t.startedAt).getTime();
      if (at < a.getTime() || at >= b.getTime()) return;
      let row = rows.get(t.profileId);
      if (!row) rows.set(t.profileId, (row = empty(t.profileId)));
      add(row, t);
      turns += 1;
    });
    const list = [...rows.values()].sort((x, y) => y.input + y.cached + y.output - (x.input + x.cached + x.output));
    return { from: a.toISOString(), to: b.toISOString(), generatedAt: new Date().toISOString(), ms: Math.round(performance.now() - started), turns, rows: list, models: this.modelsOf(list) };
  }

  /** Every turn with usage, with its session's model and the local day it started. */
  private eachTurn(fn: (t: { profileId: Id; startedAt: string; input: number; cached: number; output: number }, date: string) => void): void {
    const profileOf = new Map<Id, string>();
    for (const s of this.store.listSessions()) profileOf.set(s.id, s.profileId);
    for (const t of this.store.listTurnUsage()) {
      const profileId = profileOf.get(t.sessionId);
      const date = localDate(t.startedAt);
      const input = Number(t.input) || 0, cached = Number(t.cached) || 0, output = Number(t.output) || 0;
      if (!profileId || !date || input + output <= 0) continue;
      fn({ profileId, startedAt: t.startedAt, input, cached, output }, date);
    }
  }

  private modelsOf(rows: Iterable<{ profileId: Id }>): TokenStatsModel[] {
    const used = new Set([...rows].map((d) => d.profileId));
    return [...used].map((id) => {
      const p = this.profiles.find((x) => x.id === id);
      return p ? { profileId: id, label: p.label, runtime: p.runtime, model: p.model, removed: false } : { profileId: id, label: id, runtime: null, model: null, removed: true };
    });
  }
}

const empty = (profileId: Id): Usage => ({ profileId, input: 0, cached: 0, output: 0, turns: 0 });

function add(u: Usage, t: { input: number; cached: number; output: number }): void {
  // The runtimes' input includes what came from the cache.
  u.input += Math.max(0, t.input - t.cached);
  u.cached += Math.min(t.cached, t.input);
  u.output += t.output;
  u.turns += 1;
}
