import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { TokenStats } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import {
  addDays, byDate, columns, firstDate, fmtTokens, mondayOf, niceMax, rangeStart, smoothPath, statModels, sumRange, value, ymd,
  type ByDate, type Column, type Grain, type Metric, type StatModel, type Usage,
} from "./statsData.js";

// 设置 → 统计 (2026-10-27, design: plans/token-stats-prototype.html v2): tokens per day, week and month, per model and
// all of them. Counted again by the Host each time the page opens (重新统计 does it again).

type Style = "line" | "area" | "bar";
type View = "chart" | "table";

const GRAINS: Array<{ id: Grain; label: string }> = [{ id: "day", label: "日" }, { id: "week", label: "周" }, { id: "month", label: "月" }, { id: "total", label: "总计" }];
const METRICS: Array<{ id: Metric; label: string }> = [{ id: "all", label: "全部" }, { id: "input", label: "输入" }, { id: "cached", label: "缓存命中" }, { id: "output", label: "输出" }];
const STYLES: Array<{ id: Style; label: string }> = [{ id: "line", label: "折线" }, { id: "area", label: "面积" }, { id: "bar", label: "柱状" }];
const VIEWS: Array<{ id: View; label: string }> = [{ id: "chart", label: "图" }, { id: "table", label: "表" }];
const NOW_WORD: Record<Exclude<Grain, "total">, string> = { day: "今天", week: "本周", month: "本月" };
const RANGE: Record<Grain, string> = { day: "最近 30 天", week: "最近 12 周", month: "最近 12 个月", total: "全部时间" };

// What was chosen last: the page opens on it again (this window).
const last = { grain: "day" as Grain, metric: "all" as Metric, style: "line" as Style, view: "chart" as View, hidden: new Set<string>() };

/** The element's width, followed as it changes (设置 can be resized). */
function useWidth(): [(el: HTMLElement | null) => void, number, { current: HTMLElement | null }] {
  const [width, setWidth] = useState(0);
  const el = useRef<HTMLElement | null>(null);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    el.current = node;
    if (!node) return;
    setWidth(node.clientWidth);
    ro.current = new ResizeObserver(() => setWidth(node.clientWidth));
    ro.current.observe(node);
  }, []);
  return [ref, width, el];
}

function Seg<T extends string>({ items, value: current, onChange, label, disabled }: { items: Array<{ id: T; label: string }>; value: T; onChange(v: T): void; label: string; disabled?: boolean }) {
  return (
    <span className="stats-seg" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" aria-pressed={current === it.id} disabled={disabled} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </span>
  );
}

/** "1.31 亿" → ["1.31", "亿"] */
function split(n: number): [string, string] {
  const s = fmtTokens(n);
  const m = /^(.*?) (亿|万)$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s, ""];
}

export function StatsPage({ link }: { link: HostLink }) {
  const [stats, setStats] = useState<TokenStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [grain, setGrain] = useState(last.grain);
  const [metric, setMetric] = useState(last.metric);
  const [style, setStyle] = useState(last.style);
  const [view, setView] = useState(last.view);
  const [hidden, setHidden] = useState(() => new Set(last.hidden));
  useEffect(() => {
    Object.assign(last, { grain, metric, style, view, hidden });
  }, [grain, metric, style, view, hidden]);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStats(await call(link, "GET /api/stats/tokens"));
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [link]);
  useEffect(() => {
    void load();
  }, [load]);

  const today = useMemo(() => (stats ? new Date(stats.generatedAt) : new Date()), [stats]);
  const models = useMemo(() => (stats ? statModels(stats) : []), [stats]);
  const data = useMemo<ByDate>(() => (stats ? byDate(stats, models) : new Map()), [stats, models]);
  const shown = models.filter((m) => !hidden.has(m.id));
  const ids = shown.map((m) => m.id);
  const cols = useMemo(() => (grain === "total" ? [] : columns(data, grain, today)), [data, grain, today]);

  const head = (
    <div className="stats-top">
      <span className="settings-heading">Token 用量</span>
      {stats && (
        <span className="stats-note" data-testid="stats-counted">
          打开时已重新统计 · {new Date(stats.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })} · {stats.turns.toLocaleString("en")} 轮 · 用时 {(stats.ms / 1000).toFixed(1)} 秒
        </span>
      )}
      <span className="spacer" />
      <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void load()}>
        {busy ? "统计中…" : "重新统计"}
      </button>
    </div>
  );
  if (!stats || !models.length) {
    return (
      <section className="settings-section stats" aria-label="统计">
        {head}
        {error ? (
          <span className="form-error" role="alert">
            {error}
          </span>
        ) : (
          <span className="settings-hint">{stats ? "还没有记到用量：会话跑完一轮之后这里就有数。" : "正在统计…"}</span>
        )}
      </section>
    );
  }

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else if (shown.length > 1) next.add(id);
    setHidden(next);
  };
  const legendTotals = sumRange(data, models.map((m) => m.id), rangeStart(grain, today, data), ymd(today)).per;
  const metricLabel = METRICS.find((m) => m.id === metric)!.label;

  return (
    <section className="settings-section stats" aria-label="统计">
      {head}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <Tiles data={data} ids={ids} today={today} metric={metric} grain={grain} onGrain={setGrain} />
      <div className="stats-filters">
        <span className="stats-fgroup">
          <span className="stats-flabel">粒度</span>
          <Seg<Grain> items={GRAINS} value={grain} onChange={setGrain} label="粒度" />
        </span>
        <span className="stats-fgroup">
          <span className="stats-flabel">指标</span>
          <Seg<Metric> items={METRICS} value={metric} onChange={setMetric} label="指标" />
        </span>
        <span className="stats-fgroup">
          <span className="stats-flabel">样式</span>
          <Seg<Style> items={STYLES} value={style} onChange={setStyle} label="样式" disabled={grain === "total"} />
        </span>
      </div>
      <div className="stats-legend" role="group" aria-label="模型">
        <button type="button" className="stats-chip all" onClick={() => setHidden(new Set())}>
          {hidden.size ? "全部显示" : "全部模型"}
        </button>
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            className="stats-chip"
            aria-pressed={!hidden.has(m.id)}
            title={`${m.sub}：点一下${hidden.has(m.id) ? "显示" : "隐藏"}`}
            data-testid="stats-model"
            onClick={() => toggle(m.id)}
          >
            <span className="stats-sw" style={{ background: m.color }} />
            {m.label}
            <span className="stats-chip-v">{fmtTokens(value(legendTotals[m.id], metric))}</span>
          </button>
        ))}
      </div>

      <div className="stats-card">
        <div className="stats-card-head">
          <span className="stats-card-title">{grain === "total" ? "各模型合计" : `每${{ day: "天", week: "周", month: "月" }[grain]}用量`}</span>
          <span className="stats-card-sub">
            {RANGE[grain]} · {metricLabel}
            {grain !== "total" && style === "line" && shown.length > 1 ? " · 黑线是所选模型的合计" : ""}
          </span>
          <span className="spacer" />
          <Seg<View> items={VIEWS} value={view} onChange={setView} label="图或表" />
        </div>
        {grain === "total" ? (
          <TotalChart data={data} models={shown} metric={metric} metricLabel={metricLabel} table={view === "table"} />
        ) : view === "table" ? (
          <ChartTable cols={cols} models={shown} metric={metric} grain={grain} />
        ) : (
          <UsageChart cols={cols} models={shown} metric={metric} style={style} grain={grain} />
        )}
      </div>

      <div className="stats-card">
        <div className="stats-card-head">
          <span className="stats-card-title">按模型分开看</span>
          <span className="stats-card-sub">{RANGE[grain === "total" ? "month" : grain]} · 每张图各自的刻度</span>
        </div>
        <div className="stats-multiples">
          {shown.map((m) => (
            <Mini key={m.id} model={m} cols={grain === "total" ? columns(data, "month", today) : cols} metric={metric} />
          ))}
        </div>
      </div>

      <div className="stats-card">
        <div className="stats-card-head">
          <span className="stats-card-title">明细</span>
          <span className="stats-card-sub">{RANGE[grain]} · 按模型</span>
        </div>
        <Detail data={data} models={shown} from={rangeStart(grain, today, data)} to={ymd(today)} />
      </div>
      <span className="settings-hint">
        按每一轮开始的那天算（本机时间）。输入不含缓存命中；子 agent 和委派会话算在它们自己用的模型下。只算 Studio 记下用量的轮次：Studio 开始记之前的、和中途被打断没回报用量的不在里面。
      </span>
    </section>
  );
}

function Tiles({ data, ids, today, metric, grain, onGrain }: { data: ByDate; ids: string[]; today: Date; metric: Metric; grain: Grain; onGrain(g: Grain): void }) {
  const d = ymd(today);
  const mon = mondayOf(today);
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const prevFirst = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevSame = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth(), 0).getDate()));
  const sum = (from: Date | string, to: Date | string) => sumRange(data, ids, typeof from === "string" ? from : ymd(from), typeof to === "string" ? to : ymd(to)).total;
  const start = firstDate(data);
  const tiles: Array<{ g: Grain; label: string; cur: Usage; prev: Usage | null; cmp: string }> = [
    { g: "day", label: "今天", cur: sum(d, d), prev: sum(addDays(today, -1), addDays(today, -1)), cmp: "昨天" },
    { g: "week", label: "本周", cur: sum(mon, d), prev: sum(addDays(mon, -7), addDays(today, -7)), cmp: "上周同期" },
    { g: "month", label: "本月", cur: sum(first, d), prev: sum(prevFirst, prevSame), cmp: "上月同期" },
    { g: "total", label: "总计", cur: sum("0000-00-00", "9999-99-99"), prev: null, cmp: start ? `自 ${start} 起` : "" },
  ];
  return (
    <div className="stats-tiles">
      {tiles.map((t) => {
        const v = value(t.cur, metric);
        const p = t.prev ? value(t.prev, metric) : null;
        const [num, unit] = split(v);
        const change = p === null ? t.cmp : !p ? `${t.cmp}没有用量` : `比${t.cmp} ${v >= p ? "↑" : "↓"} ${Math.abs(Math.round(((v - p) / p) * 100))}%`;
        return (
          <button key={t.g} type="button" className="stats-tile" aria-pressed={grain === t.g} data-testid="stats-tile" title={`点一下：下面按${{ day: "天", week: "周", month: "月", total: "模型合计" }[t.g]}看`} onClick={() => onGrain(t.g)}>
            <span className="stats-tile-k">{t.label}</span>
            <span className="stats-tile-v">
              {num}
              <small>{unit}</small>
            </span>
            {metric === "all" && <span className="stats-tile-d">不含缓存 {fmtTokens(t.cur.input + t.cur.output)}</span>}
            <span className="stats-tile-d">
              {change} · {t.cur.turns.toLocaleString("en")} 轮
            </span>
          </button>
        );
      })}
    </div>
  );
}

function UsageChart({ cols, models, metric, style, grain }: { cols: Column[]; models: StatModel[]; metric: Metric; style: Style; grain: Exclude<Grain, "total"> }) {
  const [ref, width, el] = useWidth();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const W = Math.max(320, width), H = 270, L = 56, R = style === "line" ? 64 : 10, T = 16, B = 26;
  const iw = W - L - R, ih = H - T - B, n = cols.length;
  const series = models.map((m) => ({ m, vals: cols.map((c) => value(c.values[m.id], metric)) }));
  const totals = cols.map((_, i) => series.reduce((s, x) => s + x.vals[i]!, 0));
  const maxV = niceMax(Math.max(0, ...totals));
  const y = (v: number) => T + ih - (v / maxV) * ih;
  const step = iw / Math.max(1, n);
  const x = (i: number) => L + step * i + step / 2;
  const partial = cols[n - 1]?.partial ?? false;
  const withTotal = style === "line" && models.length > 1;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 48))));
  const pts = (vals: number[]) => vals.map((v, i) => [x(i), y(v)] as const);
  const done = <T,>(p: T[]) => (partial ? p.slice(0, -1) : p);
  const hint =
    !partial ? "" : style === "line" ? `最右边的空心点是${NOW_WORD[grain]}到现在的量，还没过完，所以不和前面连线。` : `带斜纹的是${NOW_WORD[grain]}，还没过完。`;

  const lines = () => {
    const out: ReactNode[] = [];
    if (withTotal) {
      const p = done(pts(totals));
      out.push(<path key="wash" d={`${smoothPath(p)}L${p[p.length - 1]![0]},${y(0)}L${p[0]![0]},${y(0)}Z`} style={{ fill: `url(#wash-${uid})` }} />);
    }
    const line = (key: string, vals: number[], color: string, w: number) => {
      const p = pts(vals);
      out.push(<path key={key} d={smoothPath(done(p))} fill="none" style={{ stroke: color }} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" />);
      if (partial && n > 1) out.push(<circle key={`${key}-now`} cx={p[n - 1]![0]} cy={p[n - 1]![1]} r={3.5} style={{ fill: "var(--panel)", stroke: color }} strokeWidth={1.75} />);
    };
    for (const s of series) line(s.m.id, s.vals, s.m.color, 1.75);
    if (withTotal) line("total", totals, "var(--text)", 2.25);
    const lv = withTotal ? totals[n - 1]! : series[0]?.vals[n - 1] ?? 0;
    out.push(
      <text key="lv" x={x(n - 1) + 8} y={y(lv) + 4} className="stats-axis-strong">
        {fmtTokens(lv)}
      </text>,
    );
    return out;
  };
  const areas = () => {
    const out: ReactNode[] = [];
    let lower = cols.map(() => 0);
    for (const s of series) {
      const upper = lower.map((v, i) => v + s.vals[i]!);
      const up = upper.map((v, i) => `${x(i)},${y(v)}`);
      const down = lower.map((v, i) => `${x(i)},${y(v)}`).reverse();
      out.push(<path key={`${s.m.id}-a`} d={`M${up.join("L")}L${down.join("L")}Z`} style={{ fill: s.m.color, fillOpacity: 0.32 }} />);
      out.push(<path key={`${s.m.id}-l`} d={`M${up.join("L")}`} fill="none" style={{ stroke: s.m.color }} strokeWidth={1.5} strokeLinejoin="round" />);
      lower = upper;
    }
    if (partial && n > 1) out.push(<rect key="now" x={x(n - 2)} y={T} width={x(n - 1) - x(n - 2)} height={ih} style={{ fill: `url(#hatch-${uid})` }} />);
    return out;
  };
  const bars = () => {
    const out: ReactNode[] = [];
    const bw = Math.max(3, Math.min(22, step * 0.56));
    cols.forEach((c, i) => {
      let acc = 0;
      const vis = series.filter((s) => s.vals[i]! > 0);
      vis.forEach((s, j) => {
        const v = s.vals[i]!, y0 = y(acc), y1 = y(acc + v), top = j === vis.length - 1;
        const h = Math.max(0, y0 - y1 - (top ? 0 : 2));
        acc += v;
        if (h <= 0) return;
        const shape = top ? { d: topRounded(x(i) - bw / 2, y1, bw, h, 4) } : { x: x(i) - bw / 2, y: y1 + 2, width: bw, height: h };
        const El = top ? "path" : "rect";
        out.push(<El key={`${c.key}-${s.m.id}`} {...shape} style={{ fill: s.m.color }} />);
        if (c.partial) out.push(<El key={`${c.key}-${s.m.id}-h`} {...shape} style={{ fill: `url(#hatch-${uid})` }} />);
      });
    });
    return out;
  };
  const hv = hover?.i;

  return (
    <div className="stats-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="用量图" data-testid="stats-chart">
          <defs>
            <pattern id={`hatch-${uid}`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={2} height={6} style={{ fill: "var(--panel)", opacity: 0.75 }} />
            </pattern>
            <linearGradient id={`wash-${uid}`} x1={0} x2={0} y1={0} y2={1}>
              <stop offset="0%" style={{ stopColor: "var(--text)", stopOpacity: 0.12 }} />
              <stop offset="100%" style={{ stopColor: "var(--text)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((k) => {
            const v = (maxV / 4) * k;
            return (
              <g key={k}>
                <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={k === 0 ? "stats-axis-line" : "stats-grid-line"} />
                <text x={L - 8} y={y(v) + 4} textAnchor="end" className="stats-axis-text">
                  {k === 0 ? "0" : fmtTokens(v)}
                </text>
              </g>
            );
          })}
          {cols.map((c, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={c.key} x={x(i)} y={H - 8} textAnchor="middle" className={c.partial ? "stats-axis-strong" : "stats-axis-text"}>
                {c.partial ? NOW_WORD[grain] : c.label}
              </text>
            ) : null,
          )}
          {hv !== undefined && style === "bar" && <rect x={L + step * hv} y={T} width={step} height={ih} style={{ fill: "var(--stat-band)" }} />}
          {style === "line" ? lines() : style === "area" ? areas() : bars()}
          {hv !== undefined && style !== "bar" && (
            <g>
              <line x1={x(hv)} x2={x(hv)} y1={T} y2={T + ih} className="stats-cross" />
              {(() => {
                let acc = 0;
                return series.map((s) => {
                  const v = style === "area" ? (acc += s.vals[hv]!) : s.vals[hv]!;
                  return <circle key={s.m.id} cx={x(hv)} cy={y(v)} r={4} style={{ fill: s.m.color, stroke: "var(--panel)" }} strokeWidth={2} />;
                });
              })()}
              {withTotal && <circle cx={x(hv)} cy={y(totals[hv]!)} r={4.5} style={{ fill: "var(--text)", stroke: "var(--panel)" }} strokeWidth={2} />}
            </g>
          )}
          {cols.map((c, i) => (
            <rect
              key={`hit-${c.key}`}
              x={L + step * i}
              y={T}
              width={step}
              height={ih}
              fill="transparent"
              onMouseMove={(e) => {
                const r = el.current?.getBoundingClientRect();
                if (r) setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top });
              }}
            />
          ))}
        </svg>
      )}
      {hover && cols[hover.i] && (
        <Tip col={cols[hover.i]!} models={models} metric={metric} total={totals[hover.i]!} left={hover.x + 220 > W ? hover.x - 214 : hover.x + 14} top={Math.max(0, hover.y - 10)} />
      )}
      {hint && <span className="stats-hint">{hint}</span>}
    </div>
  );
}

/** A bar with only its top corners rounded (the data end), square on the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Tip({ col, models, metric, total, left, top }: { col: Column; models: StatModel[]; metric: Metric; total: number; left: number; top: number }) {
  const turns = models.reduce((s, m) => s + (col.values[m.id]?.turns ?? 0), 0);
  return (
    <div className="stats-tip" style={{ left, top }} role="tooltip" data-testid="stats-tip">
      <div className="stats-tip-t">
        {col.full}
        {col.partial ? "（进行中）" : ""}
      </div>
      {[...models].reverse().map((m) => {
        const v = value(col.values[m.id], metric);
        return (
          <div key={m.id} className="stats-tip-row">
            <span className="stats-sw" style={{ background: m.color }} />
            <span className="stats-tip-n">{m.label}</span>
            <span>{v ? fmtTokens(v) : "—"}</span>
          </div>
        );
      })}
      <div className="stats-tip-sum">
        <span>合计</span>
        <span>
          {fmtTokens(total)} · {turns} 轮
        </span>
      </div>
    </div>
  );
}

function TotalChart({ data, models, metric, metricLabel, table }: { data: ByDate; models: StatModel[]; metric: Metric; metricLabel: string; table: boolean }) {
  const [ref, width] = useWidth();
  const per = sumRange(data, models.map((m) => m.id), "0000-00-00", "9999-99-99").per;
  const rows = models.map((m) => ({ m, v: value(per[m.id], metric) })).sort((a, b) => b.v - a.v);
  const sum = rows.reduce((s, r) => s + r.v, 0);
  const pct = (v: number) => (sum ? Math.round((v / sum) * 100) : 0);
  if (table) {
    return (
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>{metricLabel}</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m.id}>
                <td>
                  <ModelName m={r.m} />
                </td>
                <td>{fmtTokens(r.v)}</td>
                <td>{pct(r.v)}%</td>
              </tr>
            ))}
            <tr className="stats-total">
              <td>合计</td>
              <td>{fmtTokens(sum)}</td>
              <td>100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  const W = Math.max(320, width), rowH = 30, L = 84, R = 120, H = rows.length * rowH + 8;
  const max = niceMax(rows[0]?.v ?? 1), iw = W - L - R;
  return (
    <div className="stats-chart" ref={ref}>
      {width > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="各模型合计" data-testid="stats-chart">
          {rows.map((r, i) => {
            const yy = 4 + i * rowH, w = Math.max(2, (r.v / max) * iw);
            return (
              <g key={r.m.id}>
                <text x={L - 10} y={yy + 17} textAnchor="end" className="stats-axis-strong" style={{ fontWeight: 400 }}>
                  {r.m.label}
                </text>
                <path d={`M${L},${yy + 5}H${L + w - 4}Q${L + w},${yy + 5} ${L + w},${yy + 9}V${yy + 19}Q${L + w},${yy + 23} ${L + w - 4},${yy + 23}H${L}Z`} style={{ fill: r.m.color }} />
                <text x={L + w + 8} y={yy + 18} className="stats-axis-strong">
                  {fmtTokens(r.v)}
                  <tspan className="stats-axis-text"> · {pct(r.v)}%</tspan>
                </text>
              </g>
            );
          })}
          <line x1={L} x2={L} y1={2} y2={H - 2} className="stats-axis-line" />
        </svg>
      )}
    </div>
  );
}

function ChartTable({ cols, models, metric, grain }: { cols: Column[]; models: StatModel[]; metric: Metric; grain: Exclude<Grain, "total"> }) {
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>{{ day: "日期", week: "周（周一起）", month: "月份" }[grain]}</th>
            {models.map((m) => (
              <th key={m.id}>
                <ModelName m={m} />
              </th>
            ))}
            <th>合计</th>
          </tr>
        </thead>
        <tbody>
          {[...cols].reverse().map((c) => {
            const vs = models.map((m) => value(c.values[m.id], metric));
            return (
              <tr key={c.key}>
                <td>
                  {c.full}
                  {c.partial ? "（进行中）" : ""}
                </td>
                {vs.map((v, i) => (
                  <td key={models[i]!.id}>{v ? fmtTokens(v) : "—"}</td>
                ))}
                <td>
                  <b>{fmtTokens(vs.reduce((a, b) => a + b, 0))}</b>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModelName({ m, sub }: { m: StatModel; sub?: boolean }) {
  return (
    <span className="stats-mname">
      <span className="stats-sw" style={{ background: m.color }} />
      {m.label}
      {sub && m.sub && <small>{m.sub}</small>}
    </span>
  );
}

function Mini({ model, cols, metric }: { model: StatModel; cols: Column[]; metric: Metric }) {
  const [ref, width] = useWidth();
  const vs = cols.map((c) => value(c.values[model.id], metric));
  const total = vs.reduce((a, b) => a + b, 0);
  const max = Math.max(...vs, 1);
  const pi = vs.indexOf(Math.max(...vs));
  const n = vs.length;
  const W = Math.max(120, width), H = 54, step = (W - 6) / Math.max(1, n - 1);
  const pts = vs.map((v, i) => [i * step, H - 2 - (v / max) * (H - 6)] as const);
  const partial = cols[n - 1]?.partial ?? false;
  const done = partial ? pts.slice(0, -1) : pts;
  return (
    <div className="stats-mini" data-testid="stats-mini">
      <div className="stats-mini-head">
        <span className="stats-sw" style={{ background: model.color }} />
        <span className="stats-mini-n">{model.label}</span>
        <span className="stats-mini-v">{fmtTokens(total)}</span>
      </div>
      <div className="stats-mini-peak">
        {model.sub}
        {total > 0 && ` · 最多 ${cols[pi]?.label}（${fmtTokens(vs[pi] ?? 0)}）`}
      </div>
      <div ref={ref}>
        {width > 0 && done.length > 0 && (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <path d={`${smoothPath(done)}L${done[done.length - 1]![0]},${H}L0,${H}Z`} style={{ fill: model.color, fillOpacity: 0.14 }} />
            <path d={smoothPath(done)} fill="none" style={{ stroke: model.color }} strokeWidth={1.5} strokeLinejoin="round" />
            {partial && n > 1 && <circle cx={pts[n - 1]![0]} cy={pts[n - 1]![1]} r={2.5} style={{ fill: "var(--panel)", stroke: model.color }} strokeWidth={1.5} />}
          </svg>
        )}
      </div>
    </div>
  );
}

function Detail({ data, models, from, to }: { data: ByDate; models: StatModel[]; from: string; to: string }) {
  const { total, per } = sumRange(data, models.map((m) => m.id), from, to);
  const all = (u: Usage) => u.input + u.cached + u.output;
  const rows = models.map((m) => ({ m, u: per[m.id] ?? { input: 0, cached: 0, output: 0, turns: 0 } })).sort((a, b) => all(b.u) - all(a.u));
  const sum = all(total);
  const pct = (v: number) => (sum ? Math.round((v / sum) * 100) : 0);
  const cells = (u: Usage) => (
    <>
      <td>{fmtTokens(u.input)}</td>
      <td>{fmtTokens(u.cached)}</td>
      <td>{fmtTokens(u.output)}</td>
      <td>
        <b>{fmtTokens(all(u))}</b>
      </td>
    </>
  );
  return (
    <div className="stats-table-wrap">
      <table className="stats-table" data-testid="stats-detail">
        <thead>
          <tr>
            <th>模型</th>
            <th>输入</th>
            <th>缓存命中</th>
            <th>输出</th>
            <th>合计</th>
            <th>占比</th>
            <th>轮数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.m.id}>
              <td>
                <ModelName m={r.m} sub />
              </td>
              {cells(r.u)}
              <td>
                <span className="stats-share">
                  <i style={{ width: `${pct(all(r.u))}%` }} />
                </span>
                {pct(all(r.u))}%
              </td>
              <td>{r.u.turns.toLocaleString("en")}</td>
            </tr>
          ))}
          <tr className="stats-total">
            <td>合计</td>
            {cells(total)}
            <td>100%</td>
            <td>{total.turns.toLocaleString("en")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
