import type { Id, TokenStats, TokenStatsDay, TokenStatsModel } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";

/** YYYY-MM-DD of a time in the Host's time zone (the person's: Studio runs on their machine). */
export function localDate(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 设置 → 统计 (2026-10-27): tokens per day and model, counted from scratch each time the page opens (or 重新统计). Every
 * turn of every session counts once — subagents and delegated sessions have their own turns, under their own model —
 * and nothing is stored: the turns are the record.
 */
export class StatsFeature extends Feature {
  tokens(): TokenStats {
    const started = performance.now();
    const profileOf = new Map<Id, string>();
    for (const s of this.store.listSessions()) profileOf.set(s.id, s.profileId);
    const days = new Map<string, TokenStatsDay>();
    let turns = 0;
    for (const t of this.store.listTurnUsage()) {
      const profileId = profileOf.get(t.sessionId);
      const date = localDate(t.startedAt);
      const input = Number(t.input) || 0, cached = Number(t.cached) || 0, output = Number(t.output) || 0;
      if (!profileId || !date || input + output <= 0) continue;
      const key = `${date}|${profileId}`;
      let day = days.get(key);
      if (!day) days.set(key, (day = { date, profileId, input: 0, cached: 0, output: 0, turns: 0 }));
      // The runtimes' input includes what came from the cache.
      day.input += Math.max(0, input - cached);
      day.cached += Math.min(cached, input);
      day.output += output;
      day.turns += 1;
      turns += 1;
    }
    const used = new Set([...days.values()].map((d) => d.profileId));
    const models: TokenStatsModel[] = [...used].map((id) => {
      const p = this.profiles.find((x) => x.id === id);
      return p ? { profileId: id, label: p.label, runtime: p.runtime, model: p.model, removed: false } : { profileId: id, label: id, runtime: null, model: null, removed: true };
    });
    return {
      generatedAt: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
      turns,
      days: [...days.values()].sort((a, b) => (a.date === b.date ? a.profileId.localeCompare(b.profileId) : a.date < b.date ? -1 : 1)),
      models,
    };
  }
}
