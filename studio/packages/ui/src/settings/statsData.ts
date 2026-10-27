import { RUNTIME_LABELS, type TokenStats } from "@amo-studio/protocol";

// 设置 → 统计 (2026-10-27): the Host's tokens per day and model, cut into days, weeks (from Monday) and months here.

export type Grain = "day" | "week" | "month" | "total";
export type Metric = "all" | "input" | "cached" | "output";

export interface Usage {
  input: number;
  cached: number;
  output: number;
  turns: number;
}

/** A series: one model (a profile), or 其他 for the ones past the six colours. */
export interface StatModel {
  id: string;
  label: string;
  sub: string;
  /** A CSS colour (a --stat-sN variable). */
  color: string;
  profileIds: string[];
}

/** Six hues in a fixed order (stats.css; checked for colour-blind separation in both themes); more models fold into 其他. */
export const SLOTS = 6;

const empty = (): Usage => ({ input: 0, cached: 0, output: 0, turns: 0 });
function add(to: Usage, u: Usage): void {
  to.input += u.input;
  to.cached += u.cached;
  to.output += u.output;
  to.turns += u.turns;
}

export function value(u: Usage | undefined, metric: Metric): number {
  if (!u) return 0;
  return metric === "all" ? u.input + u.cached + u.output : u[metric];
}

/**
 * The series, most used first over all time — so a model keeps its colour whatever is filtered — the seventh on
 * folded into 其他.
 */
export function statModels(stats: TokenStats): StatModel[] {
  const total = new Map<string, number>();
  for (const d of stats.days) total.set(d.profileId, (total.get(d.profileId) ?? 0) + d.input + d.cached + d.output);
  const sorted = [...stats.models].sort((a, b) => (total.get(b.profileId) ?? 0) - (total.get(a.profileId) ?? 0));
  // Two channels may share a name (DeepSeek on Codex and on DSH): the runtime tells them apart.
  const same = (label: string) => stats.models.filter((m) => m.label === label).length > 1;
  const name = (m: TokenStats["models"][number]) => (same(m.label) && m.runtime ? `${m.label}（${RUNTIME_LABELS[m.runtime]}）` : m.label);
  const out: StatModel[] = sorted.slice(0, SLOTS).map((m, i) => ({
    id: m.profileId,
    label: name(m),
    sub: m.removed ? "已删除的渠道" : `${m.runtime ? RUNTIME_LABELS[m.runtime] : ""}${m.model ? ` · ${m.model}` : ""}`,
    color: `var(--stat-s${i + 1})`,
    profileIds: [m.profileId],
  }));
  const rest = sorted.slice(SLOTS);
  if (rest.length) out.push({ id: "other", label: "其他", sub: rest.map(name).join("、"), color: "var(--stat-other)", profileIds: rest.map((m) => m.profileId) });
  return out;
}

// ---- dates (local; the Host dates turns in the same time zone) ----

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
export const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
const WEEKDAY = "日一二三四五六";

/** Usage by date, then by series id. */
export type ByDate = Map<string, Map<string, Usage>>;
export function byDate(stats: TokenStats, models: readonly StatModel[]): ByDate {
  const seriesOf = new Map<string, string>();
  for (const m of models) for (const p of m.profileIds) seriesOf.set(p, m.id);
  const out: ByDate = new Map();
  for (const d of stats.days) {
    const id = seriesOf.get(d.profileId);
    if (!id) continue;
    let day = out.get(d.date);
    if (!day) out.set(d.date, (day = new Map()));
    let u = day.get(id);
    if (!u) day.set(id, (u = empty()));
    add(u, d);
  }
  return out;
}

export interface Column {
  key: string;
  /** Under the axis. */
  label: string;
  /** In the tooltip and the table. */
  full: string;
  /** The day, week or month still under way. */
  partial: boolean;
  values: Record<string, Usage>;
}

/** The chart's columns: the last 30 days, 12 weeks (Monday on) or 12 months, up to today. */
export function columns(data: ByDate, grain: Exclude<Grain, "total">, today: Date): Column[] {
  const out: Column[] = [];
  const fill = (from: Date, to: Date, col: Column) => {
    for (let d = from; d <= to; d = addDays(d, 1)) for (const [id, u] of data.get(ymd(d)) ?? []) add((col.values[id] ??= empty()), u);
    out.push(col);
  };
  const t = addDays(today, 0);
  if (grain === "day") {
    for (let i = 29; i >= 0; i--) {
      const d = addDays(t, -i);
      fill(d, d, { key: ymd(d), label: md(d), full: `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY[d.getDay()]}`, partial: i === 0, values: {} });
    }
  } else if (grain === "week") {
    const mon = mondayOf(t);
    for (let i = 11; i >= 0; i--) {
      const from = addDays(mon, -7 * i), sun = addDays(from, 6);
      fill(from, i === 0 ? t : sun, { key: ymd(from), label: md(from), full: `${md(from)} – ${md(sun)} 这一周`, partial: i === 0, values: {} });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const from = new Date(t.getFullYear(), t.getMonth() - i, 1), last = new Date(from.getFullYear(), from.getMonth() + 1, 0);
      const label = from.getMonth() === 0 ? `${from.getFullYear()}年1月` : `${from.getMonth() + 1}月`;
      fill(from, i === 0 ? t : last, { key: ymd(from), label, full: `${from.getFullYear()}年${from.getMonth() + 1}月`, partial: i === 0, values: {} });
    }
  }
  return out;
}

/** Totals over [from, to] (YYYY-MM-DD, inclusive) for the given series, overall and per series. */
export function sumRange(data: ByDate, ids: readonly string[], from: string, to: string): { total: Usage; per: Record<string, Usage> } {
  const total = empty();
  const per: Record<string, Usage> = {};
  for (const [date, day] of data) {
    if (date < from || date > to) continue;
    for (const id of ids) {
      const u = day.get(id);
      if (!u) continue;
      add(total, u);
      add((per[id] ??= empty()), u);
    }
  }
  return { total, per };
}

/** The first day with any use, or null. */
export const firstDate = (data: ByDate): string | null => [...data.keys()].sort()[0] ?? null;

/** Where each grain's chart and table start. */
export function rangeStart(grain: Grain, today: Date, data: ByDate): string {
  if (grain === "day") return ymd(addDays(today, -29));
  if (grain === "week") return ymd(addDays(mondayOf(today), -77));
  if (grain === "month") return ymd(new Date(today.getFullYear(), today.getMonth() - 11, 1));
  return firstDate(data) ?? ymd(today);
}

/** 1.23 亿 / 4,560 万 / 8.2 万 / 960 */
export function fmtTokens(n: number): string {
  if (n >= 1e8 || Math.round(n / 1e4) >= 1e4) return `${(n / 1e8).toFixed(n >= 1e10 ? 0 : 2)} 亿`;
  if (n >= 1e4) return `${n >= 1e7 ? Math.round(n / 1e4).toLocaleString("en") : (n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万`;
  return Math.round(n).toLocaleString("en");
}

/** Top of a 4-step axis whose steps are 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 × 10^k, so every tick is a round number. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const raw = v / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= raw) return m * p * 4;
  return 40 * p;
}

/** Monotone cubic through the points (Fritsch–Carlson): smooth, never overshooting below 0 or above a peak. */
export function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx: number[] = [], m: number[] = [], t: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]![0] - pts[i]![0];
    m[i] = (pts[i + 1]![1] - pts[i]![1]) / dx[i]!;
  }
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!, b = t[i + 1]! / m[i]!, q = a * a + b * b;
    if (q > 9) {
      const k = 3 / Math.sqrt(q);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${pts[i]![0] + h},${pts[i]![1] + t[i]! * h} ${pts[i + 1]![0] - h},${pts[i + 1]![1] - t[i + 1]! * h} ${pts[i + 1]![0]},${pts[i + 1]![1]}`;
  }
  return d;
}
