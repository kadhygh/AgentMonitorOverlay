// 脉络的楼（2026-11-15）：一个会话画成一栋楼，一轮一层。从原型 v7（2026-11-12；源文件没进 git，成品 studio/out/tracks/proto-v7.html）改来：
// 这个文件是纯 JS（不过类型检查）：绘制代码是整段从原型搬来的，等画法定下来再整理成 TypeScript。
// 原型按一份示例数据写死（子会话都在 5F、卡片位置手摆），这里吃 Host 整理好的真数据（protocol/src/tower.ts 的 TowerData），
// 子会话的区域自动摆，楼可以有上百层（首屏只框最上面十来层；贴图先画小的，镜头停下后按屏幕大小重画）。
// 这一页放在会话里的 iframe 里（TowerView.tsx）：数据由外面的页面发进来；要看某一轮的对话、打开某个子会话时告诉外面的页面。
// 用户定的（2026-11-15）：直接走 v7 的流程，用真会话来迭代体验；允许前面每轮楼板上有信息缺失（AI 没写标题的层，标题从对话里截）。
// 原型留下的设计（用户 2026-11-10、11-12 定）：子会话的卡放在开出它的那一层的区域里，后面的楼层只留「回报」小卡；楼的正面每件
// 还开着的事一根竖线通到楼顶，做完的断在做完那层；选中卡片或区域，相关的楼层竖起来正对人；点楼层，右边显示那一轮。
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
import "../../styles/base.css";
import "./tower.css";
import { applyTheme } from "../../lib/theme.ts";

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const inl = (s) => esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/^#{1,6}\s+/, "");
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };
const sstore = { get(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} } };

/* ================= 数据：外面的页面发进来；内容一变就整页重来（场景里的东西多，重建比逐个改可靠），镜头的位置留着 ================= */
const post = (m) => { try { parent.postMessage(m, "*"); } catch {} };
const D = await new Promise((res) => {
  if (window.__TRACKS_DATA__) return res(window.__TRACKS_DATA__);
  const on = (e) => { if (e.source === parent && e.data?.type === "tower.data") { removeEventListener("message", on); res(e.data.data); } };
  addEventListener("message", on); post({ type: "tower.ready" });
});
const SIG = JSON.stringify({ ...D, now: "" }), VIEW_KEY = "tower:view:" + D.sessionId;
// 外面的会话弹窗关了（人点了 ×）：这里跟着取消选中、放平，不再往外说
addEventListener("message", (e) => { if (e.source === parent && e.data?.type === "tower.popup" && !e.data.open && S.sel) { exitVertical(); select(null, true); } });
// 弹窗还开着（这一页因为数据变了重载过）：把重载前选中的那张卡片重新标出来，不竖起来、不往外说
addEventListener("message", (e) => { if (e.source !== parent || e.data?.type !== "tower.popup" || !e.data.open || S.sel) return; const k = sstore.get(VIEW_KEY)?.sel, n = k && NB[k]; if (!n) return; S.sel = k; n.kind === "region" ? drawRegion(n) : drawCard(n); renderSide(); dirty = true; });
addEventListener("message", (e) => { if (e.source !== parent || e.data?.type !== "tower.data" || JSON.stringify({ ...e.data.data, now: "" }) === SIG) return; try { saveView(); } catch {} location.reload(); });
const N = D.rounds.length, ROOF_F = N + 1, CMP = D.compact && D.compact.after <= N ? D.compact.after : 0;
const SESS = Object.fromEntries(D.sessions.map((s) => [s.key, s])), REP = Object.fromEntries(D.reports.map((r) => [r.key, r]));
const ROUND = (n) => D.rounds[n - 1];
const GLYPH = { you: "!", other: "◐", ai: "○", done: "✓", inter: "◇" };
const short = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const HOME_FLOORS = 10; // 首屏框住最上面这几层
const TEX0 = N > 24 ? 1 : 3, TEX0L = N > 24 ? 1 : 2; // 楼高时贴图先画小的，省内存
applyTheme();
$("crumb").textContent = D.title;
if (!N) { $("empty").classList.remove("hidden"); await new Promise(() => {}); }
/* ================= 布局（世界单位；卡片的字按 U 本地像素 = 1 单位来画） ================= */
const U = 16, CW = 300, SX = 50, SZ = 22, FH = 6.2, LIFT = 22, SLAB_T = 0.9;
const ZF = SZ + 0.25; // 立面上的线：贴着楼板前沿，往外一点
// 楼层名：真会话里每层多半只有主会话那一张卡（被上一层挡着），首屏靠这一行读过程，所以比原型画得大（LS 倍）、宽
const LS = 1.5, LABEL_W = 420, LABEL_H = (40 / U) * LS, LABEL_X1 = -SX + 1.4 + (LABEL_W / U) * LS; // 楼层名最多画这么宽；它右边留给立面上的线
// 楼顶上没有卡时只留前面一条：不让一块空板挡住最新的那几层
const ROOF_D = D.roof.length ? 2 * SZ : 8;
const baseY = (f) => (f === ROOF_F ? (N + 1.5) * FH : f * FH);
const cardPx = (n) => (n.kind === "report" ? 14 + 28 + 8 + 22 + 12 : 14 + 28 + 8 + 22 + (n.items?.length ? 12 + n.items.length * 23 : 0) + 12);
// 普通楼层一层只有一轮，板大多空着：这一轮的卡放大到 1.5 倍、回报卡 1.4 倍（5F 摆满了子会话，不放大），选中这一层或竖起来时字才够大
const MAIN_SC = 1.5, REP_SC = 1.4, REP_X0 = -SX + 2.5 + (CW / U) * MAIN_SC + 3 + ((CW / U) * REP_SC) / 2;
let NODES = [], NB = {}, LINKS = [], RISERS = [];
const CARD_W = CW / U;
const SPLIT = {}; for (const s of D.sessions) (SPLIT[s.at] ||= []).push(s); // 哪几层开过子会话
/** 一层楼板上的子会话区域：按开出的先后从左到右排，一排放不下换一排；整层还放不下就一起缩小。主会话那一轮的卡在左后角 */
function layoutRegions(f, list, L) {
  const many = list.length > 3; // 一层开了很多个：每个只画最近两轮
  const regs = list.map((s) => {
    const rounds = many ? s.rounds.slice(-2) : s.rounds;
    const cards = rounds.map((c) => ({ key: s.key + "-" + c.n, kind: "sess", floor: f, badge: s.key + c.n, title: c.title, desc: c.desc, meta: c.time, items: c.items, sess: s.key, round: c.n }));
    if (!cards.length) cards.push({ key: s.key + "-0", kind: "sess", floor: f, badge: s.key, title: s.title, desc: "还没有内容", meta: "", sess: s.key, round: 0 });
    const cols = cards.length > 2 ? 2 : 1, rows = Math.ceil(cards.length / cols);
    const rowH = Math.max(...cards.map((c) => cardPx(c) / U));
    return { s, cards, cols, rowH, w: cols * CARD_W + (cols - 1) * 2.25 + 2.6, h: rows * rowH + (rows - 1) * 1.4 + 4.7 };
  });
  const X0 = -26, X1 = SX - 1.5, Z0 = -SZ + 1.2, Z1 = SZ - 1.6, GX = 3.8, GZ = 2.2;
  let sc = 1, placed = [];
  for (const s of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.36]) {
    sc = s; const W = (X1 - X0) / s, H = (Z1 - Z0) / s; let x = 0, z = 0, shelf = 0; placed = [];
    for (const r of regs) { if (x > 0 && x + r.w > W) { x = 0; z += shelf + GZ; shelf = 0; } placed.push([x, z]); x += r.w + GX; shelf = Math.max(shelf, r.h); }
    if (z + shelf <= H && regs.every((r) => r.w <= W)) break;
  }
  regs.forEach((r, i) => {
    const [px, pz] = placed[i], members = [];
    r.cards.forEach((c, j) => { const col = j % r.cols, row = Math.floor(j / r.cols), h = cardPx(c) / U;
      c.sc = sc; c.x = X0 + (px + 1.3 + col * (CARD_W + 2.25) + CARD_W / 2) * sc; c.z = Z0 + (pz + 3.4 + row * (r.rowH + 1.4) + h / 2) * sc; members.push(c.key); L.push(c); });
    const s = r.s; L.push({ key: "reg:" + s.key, kind: "region", floor: f, sess: s.key, sc, members, title: `子会话 ${s.key} · ${s.title}`, short: `${s.key} · ${s.title}`, desc: `${s.total} 轮 · ${s.state.t}`, state: s.state.s });
  });
}
function buildNodes() {
  const L = [];
  // 主会话每轮一张卡。普通楼层一层只有这一张，放大；开过子会话的那层要摆区域，这张卡不放大、靠左后
  for (const r of D.rounds) { const split = !!SPLIT[r.n]; L.push({ key: "m" + r.n, kind: r.items?.some((i) => i.s === "you") ? "ask" : "main", floor: r.n, sc: split ? 1 : MAIN_SC, x: split ? -37.5 : -SX + 2.5 + (CARD_W * MAIN_SC) / 2, z: split ? -12 : -6, badge: String(r.n), title: r.title, desc: r.desc, meta: r.time, items: r.items, sess: "main", round: r.n }); }
  for (const f of Object.keys(SPLIT)) layoutRegions(+f, SPLIT[f], L);
  for (const r of D.reports) L.push({ key: r.key, kind: "report", floor: r.floor, sc: SPLIT[r.floor] ? 1 : REP_SC, x: -8, z: -6, badge: "↩", title: r.title, desc: r.desc, meta: r.meta, from: r.from, sess: r.sess, round: r.round });
  // 楼顶：等你的卡放大到 1.4 倍，排在前面；一排放不下往后再排一排
  { const sc = (it) => (it.s === "you" ? 1.4 : 1), gap = 2.5, maxW = 2 * SX - 6, rows = [[]]; let w = 0;
    for (const it of D.roof) { const cw = CARD_W * sc(it); if (rows.at(-1).length && w + gap + cw > maxW) { rows.push([]); w = 0; } rows.at(-1).push(it); w += (w ? gap : 0) + cw; }
    rows.forEach((row, ri) => { let x = -(row.reduce((a, it) => a + CARD_W * sc(it), 0) + gap * (row.length - 1)) / 2;
      for (const it of row) { const cw = CARD_W * sc(it); L.push({ key: it.key, kind: "roof", s: it.s, floor: ROOF_F, x: x + cw / 2, z: 9 - ri * 10.5, sc: sc(it), badge: GLYPH[it.s], title: it.title, desc: it.desc, ref: it }); x += cw + gap; } }); }
  for (const n of L) if (n.kind !== "region") { n.w = CARD_W * (n.sc || 1); n.h = (cardPx(n) / U) * (n.sc || 1); }
  NODES = L; NB = Object.fromEntries(L.map((n) => [n.key, n]));
  for (const it of D.roof) if (!NB[it.origin]) it.origin = "m" + N; // 来处那张卡没画出来：算在最新一轮上
  for (const n of L) if (n.kind === "region") regionFit(n);
  LINKS = [];
  for (const s of D.sessions) { const k = NB["reg:" + s.key].members; LINKS.push({ a: "m" + s.at, b: "reg:" + s.key, kind: "split" }); for (let i = 0; i + 1 < k.length; i++) LINKS.push({ a: k[i], b: k[i + 1], kind: "chain" }); }
  // 回报、楼顶这两种直连的线只在「竖起来看」时画；在楼里由立面上的线代替
  for (const r of D.reports) { const a = NB[r.from] ? r.from : SESS[r.sess] ? "reg:" + r.sess : null; if (a) LINKS.push({ a, b: r.key, kind: "report" }); LINKS.push({ a: r.key, b: "m" + r.floor, kind: "inbox" }); }
  for (const it of D.roof) LINKS.push({ a: it.origin, b: it.key, kind: "roof", s: it.s });
  // 立面上的线：每个子会话一根（从开出它的那层起；还开着就通到楼顶的卡，做完了就断在最后回报的那层）；主会话自己问出去的事
  // （中转）从问的那层到收到回复的那层，还在等就通到楼顶；主会话里别的楼顶事项各一根
  RISERS = [];
  for (const s of D.sessions) { const roofIt = D.roof.find((it) => NB[it.origin].sess === s.key), reps = D.reports.filter((r) => r.sess === s.key); RISERS.push({ key: "rz:" + s.key, sess: s.key, from: s.at, to: roofIt ? ROOF_F : Math.max(s.at, ...reps.map((r) => r.floor)), roofKey: roofIt?.key, s: s.state.s, sel: "reg:" + s.key, reps }); }
  for (const ln of D.lines) { const roofIt = D.roof.find((it) => it.line === ln.key); RISERS.push({ key: "rz:" + ln.key, from: ln.from, to: roofIt ? ROOF_F : ln.to, roofKey: roofIt?.key, s: roofIt ? roofIt.s : ln.s, sel: roofIt ? roofIt.key : ln.origin, title: ln.title, reps: ln.reps.map((k) => REP[k]).filter(Boolean) }); }
  for (const it of D.roof) { const o = NB[it.origin]; if (o.sess === "main" && !it.line) RISERS.push({ key: "rz:" + it.key, from: o.floor, to: ROOF_F, roofKey: it.key, s: it.s, sel: it.key, reps: [] }); }
  layoutRisers(); placeReports();
}
/** 回报小卡：普通楼层放在它那根线的正上方，挤了往右挪、再放不下换一排；开过子会话的那层排在主会话那张卡的下面 */
function placeReports() {
  const riserOf = {}; for (const r of RISERS) for (const rep of r.reps) riserOf[rep.key] = r;
  const byFloor = {}; for (const n of NODES) if (n.kind === "report") (byFloor[n.floor] ||= []).push(n);
  for (const f of Object.keys(byFloor)) { const list = byFloor[f], m = NB["m" + f];
    if (SPLIT[f]) { let z = m.z + m.h / 2 + 1.2; for (const n of list) { n.x = m.x; n.z = Math.min(SZ - n.h / 2 - 0.6, z + n.h / 2); z += n.h + 1; } continue; }
    const lo = REP_X0, hi = SX - 2.5 - (CARD_W * REP_SC) / 2;
    for (const n of list) n.want = riserOf[n.key] ? riserOf[n.key].x + 6 : lo; list.sort((a, b) => a.want - b.want);
    let x = -1e9, row = 0; for (const n of list) { let nx = Math.max(lo, n.want, x); if (nx > hi && x > -1e9) { row++; nx = Math.max(lo, Math.min(hi, n.want)); } n.x = Math.min(hi, nx); n.z = -6 + row * (n.h + 1.2); x = n.x + n.w + 1.5; }
  }
}
const regionsOn = (f, except) => NODES.filter((n) => n.kind === "region" && n.floor === f && n !== except);
/** 区域到楼板前沿的出线：先试正下方；被别的区域挡住、或者落在楼层名那一段里，就从侧面的空当绕出去 */
function exitOf(g) {
  const others = regionsOn(g.floor, g).map(rectOf); const [x0, x1, z0, z1] = rectOf(g);
  const clear = (x, zFrom) => x > LABEL_X1 + 1 && x < SX - 1 && !others.some((r) => x > r[0] - 0.8 && x < r[1] + 0.8 && r[3] > zFrom);
  if (clear(g.x, z1)) return { x: g.x, pts: [[g.x, z1], [g.x, SZ]] };
  const zm = (z0 + z1) / 2;
  for (const x of [x1 + 1.9, x0 - 1.9]) if (clear(x, zm)) return { x, pts: [[x < g.x ? x0 : x1, zm], [x, zm], [x, SZ]] };
  const x = Math.max(LABEL_X1 + 1.5, Math.min(SX - 1.5, g.x)), zr = Math.min(SZ - 0.6, z1 + 1); return { x, pts: [[g.x, z1], [g.x, zr], [x, zr], [x, SZ]] }; // 没有空当：贴着前沿横过去
}
function layoutRisers() {
  const over = (a, b) => a.from <= b.to && b.from <= a.to; // 两根线有没有同时经过的楼层：没有就可以用同一个位置
  const taken = (r, x, d) => RISERS.some((o) => o !== r && o.x != null && over(o, r) && Math.abs(o.x - x) < d);
  for (const r of RISERS) r.x = null;
  for (const r of RISERS) if (r.sess) { const e = exitOf(NB["reg:" + r.sess]); let x = e.x, i = 0; while (taken(r, x, 1.5) && i++ < 30) x += 1.6; x = Math.min(SX - 1, x);
    r.exit = x === e.x ? e : { x, pts: [...e.pts.slice(0, -1), [e.x, SZ - 0.5], [x, SZ - 0.5], [x, SZ]] }; r.x = x; }
  for (const r of RISERS) if (!r.sess) { const at = r.roofKey ? NB[r.roofKey].x : r.reps[0] ? NB[r.reps[0].key].x : 0; let x = Math.max(LABEL_X1 + 7.5, Math.min(SX - 4, at)), i = 0; while (taken(r, x, 4.5) && i++ < 30) x = x + 4.5 > SX - 2 ? LABEL_X1 + 3 + i : x + 4.5; r.x = x; }
}
function regionFit(g) { const s = g.sc || 1; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const k of g.members) { const n = NB[k]; x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2); z0 = Math.min(z0, n.z - n.h / 2); z1 = Math.max(z1, n.z + n.h / 2); } x0 -= 1.3 * s; x1 += 1.3 * s; z0 -= 3.4 * s; z1 += 1.3 * s; Object.assign(g, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, h: z1 - z0 }); }
const rectOf = (n) => [n.x - n.w / 2, n.x + n.w / 2, n.z - n.h / 2, n.z + n.h / 2];

/** 选中某张卡（或区域、楼顶的事）时，跟它有关的卡：同一个子会话的全部、开出它的那一轮、它的回报和收到回报的那一轮、从它来的楼顶事项 */
function related(key) {
  const n = NB[key]; const R = new Set([key]); if (!n) return R;
  const add = (k) => { if (NB[k]) R.add(k); };
  const addSess = (id) => { add("reg:" + id); for (const k of NB["reg:" + id].members) R.add(k); add("m" + SESS[id].at); for (const r of D.reports) if (r.sess === id) { add(r.key); add("m" + r.floor); } for (const it of D.roof) if (NB[it.origin].sess === id) add(it.key); };
  if (n.kind === "roof") { for (const k of related(n.ref.origin)) R.add(k); const ln = n.ref.line && D.lines.find((l) => l.key === n.ref.line); for (const k of ln?.reps || []) { add(k); add("m" + REP[k]?.floor); } return R; }
  if (n.kind === "region" || n.kind === "sess") { addSess(n.sess); return R; }
  if (n.kind === "report") { add(n.from); add("m" + n.floor); return R; }
  // 主会话的一轮
  for (const it of D.roof) if (it.origin === key) add(it.key);
  for (const r of D.reports) { if (r.floor === n.floor) { add(r.key); add(r.from); } if (r.from === key) { add(r.key); add("m" + r.floor); } }
  for (const s of SPLIT[n.floor] || []) { add("reg:" + s.key); for (const k of NB["reg:" + s.key].members) R.add(k); }
  return R;
}

/* ================= 颜色和样式 ================= */
let C = {};
const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
function readColors() {
  const g = (n) => css(n) || "#888";
  const bg = new THREE.Color(g("--bg")), dark = bg.r * 0.299 + bg.g * 0.587 + bg.b * 0.114 < 0.2; // 颜色跟 Studio 的主题走（base.css），这里只看底色深浅
  C = { surface: g("--surface"), surface2: g("--surface-2"), line: g("--line"), text: g("--text"), text2: g("--text-2"), text3: g("--text-3"), accent: g("--accent"), fill: g("--accent-fill"), soft: g("--accent-soft"), s2: g("--s2"), s3: g("--s3"), good: g("--good"), crit: g("--crit"), neutral: g("--neutral"), slab: g("--slab"), side: g("--slab-side"), card: g("--card"), ink: g("--on-primary"), sans: css("--sans") || "sans-serif", dark };
}
const stateCol = (s) => ({ you: C.accent, other: C.s3, ai: C.s2, done: C.good, inter: C.accent })[s] || C.text3;
const kindCol = (n) => (n.kind === "sess" ? C.s2 : n.kind === "relay" ? C.s3 : n.kind === "report" ? C.s2 : n.kind === "roof" ? stateCol(n.s) : n.kind === "ask" ? C.accent : C.line);

/* ================= 贴图：卡片、区域、楼层名、立牌 ================= */
const TS = 2, TSC = 3, M = 14; // 贴图倍率（卡片 3 倍）、卡片四周留给选中框和影子的边
const SIGN_W = 200, SIGN_H = 64; // 楼顶标牌在屏幕上的大小（像素），不随远近变
let renderer, maxAniso = 1;
function makeTex(wpx, hpx, s = TS, mip = true) { const c = document.createElement("canvas"); c.width = Math.ceil(wpx * s); c.height = Math.ceil(hpx * s); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; t.generateMipmaps = mip; return { c, t, s, ctx: c.getContext("2d") }; }
/** 换新贴图（尺寸变了才换），挂到它的 mesh 上 */
function ensureTex(o, wpx, hpx, sc) { const w = Math.ceil(wpx * sc), h = Math.ceil(hpx * sc); if (o.tex && o.tex.c.width === w && o.tex.c.height === h) return false; const old = o.tex; o.tex = makeTex(wpx, hpx, sc); if (o.mesh) o.mesh.material.map = o.tex.t; old?.t.dispose(); return true; }
/** 斜着看时贴图在一个方向上被压缩，会用小一级的 mipmap；取样时稍微偏向清楚的一级 */
function sharpen(m, bias = -0.4) {
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `#ifdef USE_MAP\n  vec4 sampledDiffuseColor = texture2D( map, vMapUv, ${bias.toFixed(2)} );\n  diffuseColor *= sampledDiffuseColor;\n#endif`); };
  m.customProgramCacheKey = () => "sharp" + bias; return m;
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function fit(ctx, text, w) { text = String(text); if (ctx.measureText(text).width <= w) return text; let lo = 0, hi = text.length; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, m) + "…").width <= w) lo = m; else hi = m - 1; } return text.slice(0, lo) + "…"; }
/** 折成几行：widths 里每行一个宽度，最后一行放不下就截断 */
function wrapText(ctx, text, widths) { let rest = String(text); const out = []; for (let i = 0; i < widths.length && rest; i++) { if (i === widths.length - 1 || ctx.measureText(rest).width <= widths[i]) { out.push(fit(ctx, rest, widths[i])); break; } let lo = 1, hi = rest.length; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(rest.slice(0, m)).width <= widths[i]) lo = m; else hi = m - 1; } const an = /[A-Za-z0-9]/; let cut = lo; while (cut > 1 && an.test(rest[cut - 1]) && an.test(rest[cut])) cut--; if (cut > 1) lo = cut; /* 不把 18ms、Profiler 这样的词拆成两行 */ out.push(rest.slice(0, lo).trimEnd()); rest = rest.slice(lo).trimStart(); } return out; }
function drawCard(n) {
  ensureTex(n, CW + 2 * M, cardPx(n) + 2 * M, n.texS || TSC);
  const T = n.tex; const ctx = T.ctx; const w = CW, h = cardPx(n);
  ctx.setTransform(T.s, 0, 0, T.s, 0, 0); ctx.clearRect(0, 0, w + 2 * M, h + 2 * M); ctx.translate(M, M);
  const on = S.sel === n.key, hov = S.hover === n.key; const accent = kindCol(n); const R = C.style === "editor" ? 4 : C.style === "glass" ? 12 : 9;
  ctx.fillStyle = C.dark ? "rgba(0,0,0,.28)" : "rgba(0,0,0,.08)"; rr(ctx, 3, 5, w, h, R); ctx.fill();
  if (on) { ctx.strokeStyle = C.fill; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]); rr(ctx, -8, -8, w + 16, h + 16, R + 4); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 3.5; const c = 11; for (const [cx, cy, sx, sy] of [[-8, -8, 1, 1], [w + 8, -8, -1, 1], [w + 8, h + 8, -1, -1], [-8, h + 8, 1, -1]]) { ctx.beginPath(); ctx.moveTo(cx, cy + sy * c); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * c, cy); ctx.stroke(); } }
  ctx.fillStyle = on ? C.soft : C.card; rr(ctx, 0, 0, w, h, R); ctx.fill();
  if (n.kind !== "main") { ctx.save(); rr(ctx, 0, 0, w, h, R); ctx.clip(); ctx.fillStyle = accent; ctx.fillRect(0, 0, 5, h); ctx.restore(); }
  ctx.strokeStyle = on || hov ? C.fill : accent; ctx.lineWidth = on || hov ? 2.4 : 1.2; if (n.s === "inter") ctx.setLineDash([5, 4]); rr(ctx, 0, 0, w, h, R); ctx.stroke(); ctx.setLineDash([]);
  const solid = n.kind !== "main"; ctx.font = `800 13px ${C.sans}`; const bw = Math.max(30, ctx.measureText(n.badge).width + 14);
  ctx.fillStyle = solid ? accent : C.surface2; rr(ctx, 14, 14, bw, 28, 6); ctx.fill();
  ctx.fillStyle = solid ? C.ink : C.text2; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(n.badge, 14 + bw / 2, 28.5);
  ctx.textAlign = "left"; const lod = n.lod || 0; let mw = 0;
  if (lod === 2) { // 在屏幕上很小：标题放大（最多两行）；标题只占一行时下面带一行说明；有待处理的事，最下面留最要紧的一条
    const tw1 = w - 14 - bw - 10 - 12; ctx.font = `800 25px ${C.sans}`; if (ctx.measureText(n.title).width > tw1) { ctx.font = `800 22px ${C.sans}`; if (ctx.measureText(n.title).width > tw1) ctx.font = `800 25px ${C.sans}`; } // 差一两个字放不下时先把字缩一点，不为一个字折行
    ctx.fillStyle = C.text; const lines = wrapText(ctx, n.title, [tw1, w - 28]);
    ctx.fillText(lines[0], 14 + bw + 10, 29); if (lines[1]) ctx.fillText(lines[1], 14, 63);
    else if (n.desc) { ctx.font = `500 18px ${C.sans}`; ctx.fillStyle = C.text2; ctx.fillText(fit(ctx, n.desc, w - 28), 14, 63); }
    const it = n.kind !== "report" && (n.items?.find((i) => i.s === "you" || i.s === "other" || i.s === "inter") || n.items?.[0]);
    if (it && h > 100) { const open = it.s === "you" || it.s === "other" || it.s === "inter"; ctx.font = `${open ? 800 : 500} 18px ${C.sans}`; ctx.fillStyle = stateCol(it.s); const g = GLYPH[it.s] + " "; ctx.fillText(g, 14, h - 22); const gw = ctx.measureText(g).width; ctx.fillStyle = open ? stateCol(it.s) : C.text2; ctx.fillText(fit(ctx, it.t, w - 28 - gw), 14 + gw, h - 22); }
    T.t.needsUpdate = true; return;
  }
  const k = lod === 1 ? 1.24 : 1; // 有点小：字放大一档，时间不画
  if (n.meta && !lod) { ctx.font = `500 11.5px ${C.sans}`; const meta = fit(ctx, n.meta, 120); mw = ctx.measureText(meta).width; ctx.fillStyle = C.text3; ctx.fillText(meta, w - 14 - mw, 28); }
  ctx.font = `700 ${16.5 * k}px ${C.sans}`; ctx.fillStyle = C.text; ctx.fillText(fit(ctx, n.title, w - 14 - bw - 10 - mw - (mw ? 22 : 12)), 14 + bw + 10, 28.5);
  ctx.font = `500 ${14 * k}px ${C.sans}`; ctx.fillStyle = C.text2; ctx.fillText(fit(ctx, n.desc, w - 28), 14, 61);
  if (n.items?.length && n.kind !== "report") { let yy = 78; ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(14, yy); ctx.lineTo(w - 14, yy); ctx.stroke(); yy += 6;
    for (const it of n.items) { yy += 23; ctx.font = `800 ${13 * k}px ${C.sans}`; ctx.fillStyle = stateCol(it.s); ctx.textAlign = "center"; ctx.fillText(GLYPH[it.s], 22, yy - 10); ctx.textAlign = "left"; ctx.font = `${it.s === "you" ? 700 : 500} ${13.5 * k}px ${C.sans}`; ctx.fillStyle = it.s === "you" ? C.text : C.text2; ctx.fillText(fit(ctx, it.t, w - 48), 34, yy - 10); } }
  T.t.needsUpdate = true;
}
/** 卡片在屏幕上有多小就换哪种画法：0 全画，1 字放大一档，2 只留标题。来回切的门槛错开一点，免得缩放到边界时反复重画 */
function lodOf(raw, cur) { const a = cur >= 1 ? 0.84 : 0.8, b = cur >= 2 ? 0.7 : 0.66; return raw < b ? 2 : raw < a ? 1 : 0; }
const STATE_TXT = { you: "等你", other: "等别人", ai: "AI 在做", done: "做完", inter: "插话" };
function drawRegion(n) {
  const rs = n.sc || 1, wpx = (n.w * U) / rs, hpx = (n.h * U) / rs; // 缩小了的区域：贴图按原大小画，标题条跟着一起缩
  ensureTex(n, wpx, hpx, Math.min(n.texS || TS, 4096 / Math.max(wpx, hpx)));
  const ctx = n.tex.ctx; ctx.setTransform(n.tex.s, 0, 0, n.tex.s, 0, 0); ctx.clearRect(0, 0, wpx, hpx);
  const on = S.sel === n.key, hov = S.hover === n.key; const c = C.s2, HB = 46, big = n.lod > 0;
  ctx.globalAlpha = C.dark ? 0.12 : 0.07; ctx.fillStyle = c; rr(ctx, 1, 1, wpx - 2, hpx - 2, 14); ctx.fill(); ctx.globalAlpha = 1;
  // 标题条不透明：线从区域里出去时从它下面过，不会从字缝里露出来
  ctx.save(); rr(ctx, 1.5, 1.5, wpx - 3, hpx - 3, 14); ctx.clip(); ctx.fillStyle = C.card; ctx.fillRect(0, 0, wpx, HB); ctx.globalAlpha = C.dark ? 0.28 : 0.15; ctx.fillStyle = c; ctx.fillRect(0, 0, wpx, HB); ctx.restore(); ctx.globalAlpha = 1;
  ctx.strokeStyle = on || hov ? C.fill : c; ctx.lineWidth = on ? 3.5 : hov ? 2.6 : 1.8; ctx.setLineDash(on ? [] : [8, 6]); rr(ctx, 1.5, 1.5, wpx - 3, hpx - 3, 14); ctx.stroke(); ctx.setLineDash([]);
  // 标题条右端：这条线现在的状态（等你 / 等别人 / 做完）
  ctx.textBaseline = "middle"; ctx.textAlign = "right"; ctx.font = `800 ${big ? 19 : 15}px ${C.sans}`; const st = `${GLYPH[n.state]} ${STATE_TXT[n.state]}`; const sw = ctx.measureText(st).width; ctx.fillStyle = stateCol(n.state); ctx.fillText(st, wpx - 16, 24.5);
  ctx.textAlign = "left"; ctx.font = `800 ${big ? 23 : 19}px ${C.sans}`; ctx.fillStyle = on ? C.fill : c; const tmax = wpx - 18 - sw - 30, title = ctx.measureText(n.title).width <= tmax ? n.title : fit(ctx, n.short, tmax); ctx.fillText(title, 18, 24.5); // 区域窄、放不下时不写「子会话」三个字
  const tw = ctx.measureText(title).width, room = wpx - 18 - tw - 12 - sw - 30;
  if (!big && room > 70) { ctx.font = `600 13.5px ${C.sans}`; ctx.fillStyle = C.text2; ctx.fillText(fit(ctx, "· " + n.desc, room), 18 + tw + 12, 25.5); }
  n.tex.t.needsUpdate = true;
}
function drawLabel(F) {
  const roof = F.f === ROOF_F, on = S.selFloor === F.f || (V.on && V.floors.some((x) => x.f === F.f && x.rel));
  // 几楼 · 这一轮做了什么 · 几点。标题在前、字大一些：首屏整栋楼排紧以后，靠这一行读出过程
  const r = roof ? null : ROUND(F.f); const t1 = roof ? "楼顶" : F.f + "F", t2 = roof ? (D.roof.length ? "现在还没完的事" : "现在没有等着的事") : r.title, t3 = roof ? "" : r.time;
  ensureTex(F.label, 640, 40, F.label.texS || TS); const ctx = F.label.tex.ctx; ctx.setTransform(F.label.tex.s, 0, 0, F.label.tex.s, 0, 0); ctx.clearRect(0, 0, 640, 40);
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.font = `800 28px ${C.sans}`; ctx.fillStyle = on || roof ? C.fill : C.text3; ctx.fillText(t1, 2, 31);
  const w1 = ctx.measureText(t1).width; ctx.font = `500 13.5px ${C.sans}`; const w3 = t3 ? ctx.measureText(t3).width + 10 : 0;
  ctx.font = `700 20px ${C.sans}`; ctx.fillStyle = on || F.f > CMP ? C.text : C.text2; const tt = fit(ctx, t2, LABEL_W - w1 - 14 - w3); ctx.fillText(tt, w1 + 12, 30); const w2 = ctx.measureText(tt).width;
  if (t3) { ctx.font = `500 13.5px ${C.sans}`; ctx.fillStyle = C.text3; ctx.fillText(t3, w1 + 12 + w2 + 10, 30); }
  F.label.tex.t.needsUpdate = true;
}

/* ================= 场景 ================= */
const wrap = $("scenewrap"), cv = $("scene");
renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
maxAniso = renderer.capabilities.getMaxAnisotropy();
const scene = new THREE.Scene();
const pcam = new THREE.PerspectiveCamera(32, 1, 2, 4000), ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
const cam = { pivot: [0, 0, 0], yaw: 0, pitch: 0.86, dist: 140, ortho: false };
let W = 0, H = 0, dirty = true, HOME = null;
const flatGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // 躺在楼板上，贴图上方朝里
const upGeo = new THREE.PlaneGeometry(1, 1); // 立着，正面朝外（立牌）
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const S = { sel: null, hover: null, selFloor: null, win: null };
const V = { on: false, key: null, rel: new Set(), floors: [], others: N > 16 ? "hide" : "semi", saved: null }; // 楼高时夹在中间的楼层默认藏起来，不然竖起来的一列太长
const FLOORS = [];
const pickables = [];
let compactLine, compactTag;
const BV = { cur: 1 }; // 1 = 在楼里，0 = 竖起来看；立面上的线只在楼里画，回报、楼顶的直连线只在竖起来时画
const XLINES = []; // 立面上的线、出线，窗口变大小时一起改分辨率
function xline(o) { const L = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffffff, transparent: true, ...o })); L.renderOrder = 0.9; L.visible = false; scene.add(L); XLINES.push(L); return L; }
function setLine(L, pts) { const k = pts.map((v) => v.toFixed(2)).join(); if (L.userData.k === k) return; L.userData.k = k; L.geometry.dispose(); L.geometry = new LineGeometry().setPositions(pts); if (L.material.dashed) L.computeLineDistances(); }

function mat(color, extra) { return new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, ...extra }); }
function buildScene() {
  for (let f = 1; f <= ROOF_F; f++) {
    const g = new THREE.Group(); scene.add(g);
    const top = mat(C.slab), side = mat(C.side), side2 = mat(C.side);
    const slab = new THREE.Mesh(boxGeo, [side2, side2, top, side, side, side2]); slab.userData = { key: "floor:" + f }; g.add(slab); pickables.push(slab);
    const tint = new THREE.Mesh(flatGeo, mat(C.fill, { opacity: 0, depthWrite: false })); tint.position.y = 0.01; tint.renderOrder = 0.5; g.add(tint);
    const outline = new Line2(new LineGeometry(), new LineMaterial({ color: new THREE.Color(C.line).getHex(), linewidth: 1, transparent: true })); g.add(outline);
    const labelTex = makeTex(640, 40, TEX0L); const label = new THREE.Mesh(flatGeo, sharpen(new THREE.MeshBasicMaterial({ map: labelTex.t, transparent: true, depthWrite: false }))); label.scale.set((640 / U) * LS, 1, LABEL_H); label.renderOrder = 1; g.add(label);
    const F = { f, g, slab, top, sides: [side, side2], tint, outline, label: { mesh: label, tex: labelTex, texS: TEX0L }, cur: null, tgt: null };
    FLOORS[f] = F;
  }
  for (const n of NODES) {
    const F = FLOORS[n.floor];
    if (n.kind === "region") { n.texS = TEX0L; n.mesh = new THREE.Mesh(flatGeo, sharpen(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }))); drawRegion(n); n.mesh.material.map = n.tex.t; n.mesh.renderOrder = 1; }
    else { n.texS = TEX0; n.tex = makeTex(CW + 2 * M, cardPx(n) + 2 * M, TEX0); n.mesh = new THREE.Mesh(flatGeo, sharpen(new THREE.MeshBasicMaterial({ map: n.tex.t, transparent: true, alphaTest: 0.02 }))); n.mesh.renderOrder = 2; drawCard(n); }
    n.mesh.userData = { key: n.key }; n.op = 1; n.opT = 1; F.g.add(n.mesh); pickables.push(n.mesh);
    if (n.ref?.sign) {
      // 标牌是叠在场景上的网页元素（和界面一样清楚），位置每帧跟着卡片算；下面一根线（在场景里）连到卡片
      const el = document.createElement("button"); el.className = "sign"; el.type = "button"; el.innerHTML = `<i>!</i><span><b>${esc(n.ref.sign)}</b><em>点一下去处理</em></span>`;
      el.addEventListener("click", () => { select(n.key); openSrc(n.key); }); el.addEventListener("mouseenter", () => { setHover(n.key); el.classList.add("on"); }); el.addEventListener("mouseleave", () => { setHover(null); el.classList.remove("on"); });
      $("signs").appendChild(el);
      const lead = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffffff, linewidth: 1.6, transparent: true, depthTest: false })); lead.renderOrder = 9; scene.add(lead);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false })); dot.renderOrder = 9; scene.add(dot);
      n.sign = { el, lead, dot };
    }
    placeNode(n);
  }
  // 压缩：立面上一条横的虚线，贴在压缩后第一层的楼板下沿；说明是叠在场景上的网页元素，放在竖线之间最宽的空当里
  compactLine = xline({ dashed: true, dashSize: 1.1, gapSize: 0.8, linewidth: 1.6 });
  compactTag = document.createElement("div"); compactTag.className = "cmp"; compactTag.textContent = CMP ? `上下文压缩 ${D.compact.time} · 这以下 AI 只剩摘要` : ""; compactTag.style.display = "none"; $("signs").appendChild(compactTag);
  // 立面上的线和线上的图钉（图钉也是网页元素：起点写是谁，回报的那层一个 ↩，做完的那层一个 ✓）
  const pin = (r, f, g, text, tipText, cls) => { const el = document.createElement("button"); el.type = "button"; el.className = "pin " + (cls || ""); el.innerHTML = `<i>${esc(g)}</i>${text ? `<span>${esc(text)}</span>` : ""}`; el.title = tipText || ""; el.addEventListener("click", () => select(r.sel)); el.addEventListener("mouseenter", () => setHover(r.sel)); el.addEventListener("mouseleave", () => setHover(null)); $("signs").appendChild(el); r.pins.push({ el, f, k: null }); };
  for (const r of RISERS) {
    r.segs = {}; r.pins = []; const dashed = r.s === "inter";
    for (let f = r.from; f < Math.min(r.to, N); f++) r.segs[f] = xline({ dashed, linewidth: 2.4 });
    if (r.roofKey) r.fan = xline({ dashed, linewidth: 2.4 });
    r.repFeed = r.reps.map(() => xline({ linewidth: 2.2 }));
    if (r.sess) { r.feed = xline({ linewidth: 2.2 });
      pin(r, r.from, r.sess, short(SESS[r.sess].title, 14), `子会话 ${r.sess} · ${SESS[r.sess].title} · ${GLYPH[r.s]} ${STATE_TXT[r.s]}。点一下竖起来看`, "sess");
      for (const rep of r.reps) { const end = !r.roofKey && rep.floor === r.to && r.s === "done"; pin(r, rep.floor, end ? "✓" : "↩", end ? `${r.sess} 做完，已回报` : "", `${rep.title} ${rep.meta} · ${rep.desc}`, end ? "done" : "sess"); } }
    else { pin(r, r.from, r.roofKey ? GLYPH[r.s] : "?", r.title ? short(r.title, 14) : r.s === "inter" ? "插话" : "", r.roofKey ? `${NB[r.roofKey].title} · 从 ${r.from}F 来` : `${r.title} · ${r.from}F 问出去的`, r.s);
      for (const rep of r.reps) pin(r, rep.floor, "↩", "", `${rep.title} ${rep.meta} · ${rep.desc}`, r.s); }
  }
  for (const l of LINKS) { l.line = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffffff, linewidth: 2, transparent: true, dashed: l.kind === "split" || l.kind === "inbox" || l.kind === "relay", dashSize: 0.9, gapSize: 0.6 })); l.line.renderOrder = 0.8; scene.add(l.line); } // 线在区域底色和标题下面画，不压住区域的标题字
  applyColors();
}
function placeNode(n) {
  const isCard = n.kind !== "region", sc = n.sc || 1; const pw = isCard ? ((CW + 2 * M) / U) * sc : n.w, ph = isCard ? ((cardPx(n) + 2 * M) / U) * sc : n.h;
  n.mesh.scale.set(pw, 1, ph); n.mesh.position.set(n.x, isCard ? 0.06 : 0.03, n.z);
}
function applyColors() {
  for (let f = 1; f <= ROOF_F; f++) { const F = FLOORS[f];
    // 蓝图：楼板上画网格（一格 4 个单位）
    if (C.style === "blueprint") { if (!F.grid) { const g = document.createElement("canvas"); g.width = g.height = 64; F.grid = new THREE.CanvasTexture(g); F.grid.wrapS = F.grid.wrapT = THREE.RepeatWrapping; F.grid.colorSpace = THREE.SRGBColorSpace; F.grid.anisotropy = maxAniso; }
      const gx = F.grid.image.getContext("2d"); gx.fillStyle = C.slab; gx.fillRect(0, 0, 64, 64); gx.strokeStyle = C.line; gx.globalAlpha = 0.55; gx.lineWidth = 2; gx.strokeRect(0, 0, 64, 64); gx.globalAlpha = 1; F.grid.needsUpdate = true; F.top.map = F.grid; F.outKey = null; }
    else F.top.map = null;
    F.top.needsUpdate = true; F.top.color.set(F.top.map ? "#ffffff" : C.slab); for (const m of F.sides) m.color.set(C.side); F.sides[1].color.multiplyScalar(0.92); F.tint.material.color.set(C.fill); drawLabel(F); }
  for (const n of NODES) { if (n.kind === "region") drawRegion(n); else drawCard(n); if (n.sign) { n.sign.el.style.setProperty("--sc", stateCol(n.s)); n.sign.el.style.color = C.ink; } }
  compactLine.material.color.set(C.crit);
  // 立面上的线：子会话的用子会话的蓝，主会话里出来的事用它状态的颜色；图钉按状态上色
  const ink = C.ink;
  for (const r of RISERS) { const col = r.sess ? C.s2 : stateCol(r.s); for (const L of [...Object.values(r.segs), r.fan, r.feed, ...(r.repFeed || [])]) if (L) L.material.color.set(col); for (const p of r.pins) { p.el.style.setProperty("--pc", p.el.classList.contains("done") ? C.good : col); p.el.style.setProperty("--pi", ink); } }
  for (const l of LINKS) l.line.material.color.set(l.kind === "roof" ? stateCol(l.s) : l.kind === "relay" ? C.s3 : C.s2);
  for (const n of NODES) if (n.sign) { n.sign.lead.material.color.set(stateCol(n.s)); n.sign.dot.material.color.set(stateCol(n.s)); }
  dirty = true;
}

/* ================= 每层的状态：楼里（平躺、可升起）和竖起来（立着、只框住相关的卡），每帧往目标平滑过去 ================= */
function floorTargets() {
  const col = V.on ? Object.fromEntries(V.floors.map((x) => [x.f, x])) : null;
  for (let f = 1; f <= ROOF_F; f++) {
    const F = FLOORS[f]; let t;
    if (col && col[f]) { const c = col[f]; t = { py: c.y + (c.z0 + c.z1) / 2, rx: Math.PI / 2, cx: (V.x0 + V.x1) / 2, w: V.x1 - V.x0, cz: (c.z0 + c.z1) / 2, d: c.z1 - c.z0, op: c.rel ? 1 : 0.35, lx: V.x0 + 1.2, lz: c.z0 + 0.6, tint: 0 }; }
    else if (col) t = { py: baseY(f), rx: 0, cx: 0, w: 2 * SX, cz: 0, d: 2 * SZ, op: 0, lx: -SX + 1.4, lz: SZ - 0.2 - LABEL_H, tint: 0 }; // 不在这一列的楼层：原地淡出
    else { const up = S.selFloor != null && S.selFloor < ROOF_F && f > S.selFloor; t = { py: baseY(f) + (up ? LIFT : 0), rx: 0, cx: 0, w: 2 * SX, cz: 0, d: 2 * SZ, op: up ? 0 : 1, lx: -SX + 1.4, lz: SZ - 0.2 - LABEL_H, tint: f === ROOF_F ? (C.dark ? 0.1 : 0.06) : 0 }; } // 楼层名贴着前沿：楼层排紧以后，上一层只露出下一层前面这一条
    if (f === ROOF_F && !(col && col[f])) { t.cz = SZ - ROOF_D / 2; t.d = ROOF_D; }
    F.tgt = t; if (!F.cur) F.cur = { ...t };
  }
  for (const n of NODES) n.opT = V.on ? (V.rel.has(n.key) ? 1 : 0) : 1;
  dirty = true;
}
const KEYS = ["py", "rx", "cx", "w", "cz", "d", "op", "lx", "lz", "tint"];
const NEAR = { py: 0.5, cx: 0.5, w: 0.5, cz: 0.5, d: 0.5, lx: 0.5, lz: 0.5, rx: 0.03, op: 0.06, tint: 1 };
let settling = false; // 楼层离停下还远不远：快停稳时就可以按屏幕大小重画贴图了，不用等最后那一点点慢慢靠过去（v6 里换层后字要糊 1 秒多才清楚）
function stepFloors(dt) {
  let moving = false; const k = Math.min(1, dt * 7); settling = false;
  for (let f = 1; f <= ROOF_F; f++) { const F = FLOORS[f]; for (const key of KEYS) { const d = F.tgt[key] - F.cur[key]; if (Math.abs(d) > 0.002) { F.cur[key] += d * k; moving = true; if (Math.abs(d) > NEAR[key]) settling = true; } else F.cur[key] = F.tgt[key]; } }
  for (const n of NODES) { const d = n.opT - n.op; if (Math.abs(d) > 0.004) { n.op += d * k; moving = true; } else n.op = n.opT; }
  { const t = V.on ? 0 : 1, d = t - BV.cur; if (Math.abs(d) > 0.004) { BV.cur += d * k; moving = true; } else BV.cur = t; }
  return moving;
}
function applyFloors() {
  for (let f = 1; f <= ROOF_F; f++) {
    const F = FLOORS[f], c = F.cur; F.g.position.set(0, c.py, 0); F.g.rotation.x = c.rx;
    F.slab.scale.set(c.w, SLAB_T, c.d); F.slab.position.set(c.cx, -SLAB_T / 2, c.cz);
    F.tint.scale.set(c.w, 1, c.d); F.tint.position.set(c.cx, 0.012, c.cz); F.tint.material.opacity = c.tint * c.op;
    const solid = c.op > 0.97; for (const m of [F.top, ...F.sides]) { m.opacity = c.op; m.depthWrite = solid; }
    F.g.visible = c.op > 0.01;
    const x0 = c.cx - c.w / 2, x1 = c.cx + c.w / 2, z0 = c.cz - c.d / 2, z1 = c.cz + c.d / 2, y = 0.02;
    const ok = [x0, x1, z0, z1].map((v) => v.toFixed(3)).join(); if (F.outKey !== ok) { F.outKey = ok; if (F.top.map) F.top.map.repeat.set(c.w / 4, c.d / 4); F.outline.geometry.dispose(); F.outline.geometry = new LineGeometry().setPositions([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y, z0]); }
    const hl = S.selFloor === f || f === ROOF_F || (V.on && V.floors.some((x) => x.f === f && x.rel));
    F.outline.material.color.set(hl ? C.fill : C.line); F.outline.material.linewidth = S.selFloor === f ? 3 : hl ? 2 : 1; F.outline.material.opacity = Math.min(1, c.op * (c.op < 0.5 ? 1.2 : 1));
    const lw = (640 / U) * LS, lh = LABEL_H; F.label.mesh.position.set(c.lx + lw / 2, 0.05, c.lz + lh / 2); F.label.mesh.material.opacity = V.on || c.rx > 0.02 ? Math.max(c.op, c.op > 0.05 ? 0.5 : 0) : c.op; // 升起来的楼层：楼层名跟着淡掉（层排紧以后，留着半透明的字会压在选中那层上）；竖起来时夹在中间的楼层还留着半透明的名字
  }
  for (const n of NODES) { const F = FLOORS[n.floor]; const o = n.op * F.cur.op; n.mesh.material.opacity = o; n.mesh.material.depthWrite = n.kind !== "region" && o > 0.97; n.mesh.visible = o > 0.01; }
}
/** 立面上的线。楼层升起、变透明时一段一段跟着走；竖起来看时全部收掉 */
function applyRisers() {
  const bv = BV.cur * BV.cur, py = (f) => FLOORS[f].cur.py, op = (f) => FLOORS[f].cur.op;
  const show = (L, o, pts, lw) => { L.visible = o > 0.03; if (!L.visible) return; setLine(L, pts); L.material.opacity = Math.min(1, o); L.material.linewidth = lw; };
  for (const r of RISERS) {
    const hl = S.hover === r.sel || S.sel === r.sel || (r.roofKey && (S.hover === r.roofKey || S.sel === r.roofKey)); const lw = hl ? 3.8 : 2.4, base = (r.s === "done" ? 0.7 : 1) * bv, x = r.x;
    for (let f = r.from; f < Math.min(r.to, N); f++) show(r.segs[f], (Math.min(op(f), op(f + 1)) < 0.5 ? 0 : 1) * base, // 上面的楼层升起来以后，通到它们的那一段不画，免得横在选中的那层上
       [x, py(f) - SLAB_T / 2, ZF, x, py(f + 1) - SLAB_T / 2, ZF], lw);
    if (r.fan) { // 最上面一段：先直着上去一点，再斜到楼顶那张卡的正下方，翻过楼顶前沿，接到卡片
      const card = NB[r.roofKey], y0 = py(N) - SLAB_T / 2, yR = py(ROOF_F), y1 = y0 + (yR - SLAB_T - y0) * 0.3, cx = Math.max(-SX + 1, Math.min(SX - 1, card.x)), cz = Math.min(SZ, card.z + card.h / 2);
      show(r.fan, (Math.min(op(N), op(ROOF_F)) < 0.5 ? 0 : 1) * card.op * base, [x, y0, ZF, x, y1, ZF, cx, yR - SLAB_T, ZF, cx, yR + 0.05, ZF, cx, yR + 0.05, cz], lw); }
    if (r.feed) { // 开出它的那层楼板上：区域到前沿的出线
      const g = NB["reg:" + r.sess], y = py(g.floor) + 0.04, pts = []; for (const [px, pz] of r.exit.pts) pts.push(px, y, pz); pts.push(x, y, ZF, x, py(g.floor) - SLAB_T / 2, ZF);
      show(r.feed, g.mesh.material.opacity * bv, pts, lw);
    }
    r.reps.forEach((rep, i) => { // 回报那一层：从前沿接到回报小卡
      const card = NB[rep.key], y = py(rep.floor) + 0.04, pts = [x, py(rep.floor) - SLAB_T / 2, ZF, x, y, ZF, x, y, SZ];
      if (Math.abs(x - card.x) < card.w / 2 - 0.8) pts.push(x, y, card.z + card.h / 2); else pts.push(x, y, card.z, card.x + (x > card.x ? 1 : -1) * card.w / 2, y, card.z);
      show(r.repFeed[i], (op(rep.floor) < 0.5 ? 0 : 1) * card.mesh.material.opacity * bv, pts, lw); }); // 升起来变淡的楼层上不画，免得一根淡线横在选中的那层上
  }
  // 压缩线：贴在压缩后第一层的楼板下沿
  if (CMP) { const yc = py(CMP + 1) - SLAB_T - 0.12; show(compactLine, Math.min(op(CMP), op(CMP + 1)) * bv * 0.9, [-SX, yc, ZF, SX, yc, ZF], 1.6); } else compactLine.visible = false;
}
const _pp = new THREE.Vector3();
/** 图钉和压缩说明：叠在场景上的网页元素，每帧算到屏幕上的位置 */
function updatePins(c) {
  const k = Math.max(0.6, Math.min(1, HOME ? HOME.dist / cam.dist : 1)), bv = BV.cur * BV.cur;
  const place = (el, x, y, z, o, shift) => { _pp.set(x, y, z).project(c); const vis = o > 0.3 && _pp.z < 1; el.style.display = vis ? "" : "none"; if (!vis) return; el.style.opacity = Math.min(1, o); el.style.transform = `translate(${(((_pp.x + 1) / 2) * W).toFixed(1)}px, ${(((1 - _pp.y) / 2) * H).toFixed(1)}px) ${shift} scale(${k.toFixed(3)})`; };
  for (const r of RISERS) for (const p of r.pins) { const F = FLOORS[p.f]; place(p.el, r.x, F.cur.py - SLAB_T / 2, ZF, F.cur.op * bv, "translate(-11px, -50%)"); p.el.classList.toggle("on", S.hover === r.sel || S.sel === r.sel); }
  // 压缩说明放在穿过这一层的竖线之间最宽的空当里
  if (!CMP) return;
  const xs = [LABEL_X1, ...RISERS.filter((r) => r.from <= CMP && r.to > CMP).map((r) => r.x).sort((a, b) => a - b), SX]; let best = 0; for (let i = 1; i + 1 < xs.length; i++) if (xs[i + 1] - xs[i] > xs[best + 1] - xs[best]) best = i;
  place(compactTag, (xs[best] + xs[best + 1]) / 2, FLOORS[CMP + 1].cur.py - SLAB_T - 0.12, ZF, Math.min(FLOORS[CMP].cur.op, FLOORS[CMP + 1].cur.op) * bv, "translate(-50%, -50%)");
}
const tmpV = new THREE.Vector3();
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();
/** 楼板上一段横线（本地坐标 x0→x1）在屏幕上有多少个物理像素 */
function screenPx(F, x0, x1, y, z, c) { F.g.updateMatrixWorld(); F.g.localToWorld(_p1.set(x0, y, z)).project(c); F.g.localToWorld(_p2.set(x1, y, z)).project(c); if (_p1.z > 1 || _p2.z > 1) return 0; return Math.hypot(((_p2.x - _p1.x) * W) / 2, ((_p2.y - _p1.y) * H) / 2) * renderer.getPixelRatio(); }
const quant = (v) => Math.pow(2, Math.ceil(Math.log2(Math.max(v, 1e-3)) * 2) / 2); // 往上取到半个八度，来回小幅缩放时不反复重画
/** 镜头停下来以后：每张卡、区域、楼层名按它在屏幕上的像素重画贴图，一个贴图像素对一个屏幕像素，字就是清楚的。每帧最多重画 8 个，返回还有没有没画完的 */
function refreshRes(c) {
  let budget = 8; const pr = renderer.getPixelRatio();
  // 每层先量一张标准卡片在这层中间有多大：同一层的卡用同一种画法，不会一张大字一张小字
  for (let f = 1; f <= ROOF_F; f++) { const F = FLOORS[f]; if (!F.g.visible) continue; const px = screenPx(F, F.cur.cx - CW / U / 2, F.cur.cx + CW / U / 2, 0.06, F.cur.cz, c); if (px) F.raw = px / CW / pr; }
  for (const n of NODES) {
    if (!n.mesh.visible || n.mesh.material.opacity < 0.3) continue;
    const F = FLOORS[n.floor], rs = n.sc || 1, lw = n.kind === "region" ? (n.w * U) / rs : CW + 2 * M, hw = n.mesh.scale.x / 2;
    const px = screenPx(F, n.x - hw, n.x + hw, 0.06, n.z, c); if (!px) continue;
    const sc = Math.min(n.kind === "region" ? 4096 / ((Math.max(n.w, n.h) * U) / rs) : 5, Math.max(0.75, quant(px / lw)));
    // 同时定画法：在屏幕上小到字看不清时，换成大字、少内容（见 lodOf）
    const raw = (F.raw ?? px / lw / pr) * (n.sc || 1), lod = n.kind === "region" ? (raw < (n.lod ? 0.84 : 0.8) ? 1 : 0) : lodOf(raw, n.lod || 0);
    if (n.texS === sc && (n.lod || 0) === lod) continue; if (budget-- <= 0) return true;
    n.texS = sc; n.lod = lod; n.kind === "region" ? drawRegion(n) : drawCard(n);
  }
  for (let f = 1; f <= ROOF_F; f++) {
    const F = FLOORS[f], L = F.label.mesh; if (!F.g.visible || L.material.opacity < 0.3) continue;
    const px = screenPx(F, L.position.x - L.scale.x / 2, L.position.x + L.scale.x / 2, 0.05, L.position.z, c); if (!px) continue;
    const sc = Math.min(5, Math.max(0.75, quant(px / 640))); if (F.label.texS === sc) continue; if (budget-- <= 0) return true;
    F.label.texS = sc; drawLabel(F);
  }
  return false;
}
const _a = new THREE.Vector3(), _top = new THREE.Vector3(), _up = new THREE.Vector3(), _fw = new THREE.Vector3();
function updateSigns(c) {
  const th = Math.tan(pcam.fov * Math.PI / 360); c.getWorldDirection(_fw); _up.set(0, 1, 0).applyQuaternion(c.quaternion);
  for (const n of NODES) {
    if (!n.sign) continue; const F = FLOORS[n.floor]; const o = n.op * F.cur.op; const { el, lead, dot } = n.sign;
    const vis = o > 0.01 && F.cur.rx < 0.3; lead.visible = dot.visible = vis; el.style.display = vis ? "" : "none"; if (!vis) continue;
    F.g.updateMatrixWorld(); F.g.localToWorld(_a.set(n.x, 0.07, n.z - n.h / 2 + 0.6));
    const k = Math.max(0.6, Math.min(1, HOME ? HOME.dist / cam.dist : 1)); // 拉得比首屏远时标牌跟着缩小一些，免得挤在一起
    const d = cam.ortho ? cam.dist : Math.max(1, _top.copy(_a).sub(c.position).dot(_fw)); const wpp = ((2 * d * th) / H) * k; // 这个深度上一个屏幕像素多大
    _top.copy(_a); _top.y += 70 * wpp;
    _p1.copy(_top).project(c); const sx = ((_p1.x + 1) / 2) * W, sy = ((1 - _p1.y) / 2) * H;
    el.style.transform = `translate(${sx.toFixed(1)}px, ${(sy - 7 * k).toFixed(1)}px) translate(-50%, -100%) scale(${k.toFixed(3)})`; el.style.opacity = o;
    const pts = [_a.x, _a.y, _a.z, _top.x, _top.y, _top.z]; const lk = pts.map((v) => v.toFixed(2)).join(); if (n.sign.key !== lk) { n.sign.key = lk; lead.geometry.dispose(); lead.geometry = new LineGeometry().setPositions(pts); }
    dot.position.copy(_a); dot.scale.setScalar(4 * wpp);
    lead.material.opacity = dot.material.opacity = o;
  }
}
function nodePoint(n, h) { const F = FLOORS[n.floor]; F.g.updateMatrixWorld(); const x = n.kind === "region" ? n.x - n.w / 2 : n.x, z = n.kind === "region" ? n.z - n.h / 2 + 1.7 : n.z; return F.g.localToWorld(tmpV.set(x, h, z)).toArray(); }
const wpt = (f, x, z) => { const F = FLOORS[f]; F.g.updateMatrixWorld(); return F.g.localToWorld(tmpV.set(x, 0.04, z)).toArray(); };
/** 拆分的线（同一层：拆分那一轮 → 区域）：挨着就横着直连；上下对着就竖着连；否则沿楼板后沿绕过去，不横穿别的区域 */
function splitPath(m, g) {
  const [mx0, mx1, mz0, mz1] = rectOf(m), [gx0, gx1, gz0, gz1] = rectOf(g), f = m.floor, others = regionsOn(f, g).map(rectOf);
  const P = (pts) => pts.flatMap(([x, z]) => wpt(f, x, z));
  const blocked = (xa, xb, z) => others.some((r) => r[2] < z && r[3] > z && r[0] < Math.max(xa, xb) && r[1] > Math.min(xa, xb));
  if (gx0 >= mx1 || gx1 <= mx0) { const right = gx0 >= mx1, xa = right ? mx1 : mx0, xb = right ? gx0 : gx1; if (m.z > gz0 + 1.6 && m.z < gz1 - 1 && !blocked(xa, xb, m.z)) return P([[xa, m.z], [xb, m.z]]); }
  if (m.x > gx0 && m.x < gx1) { if (gz0 >= mz1) return P([[m.x, mz1], [m.x, gz0]]); if (gz1 <= mz0) return P([[m.x, mz0], [m.x, gz1]]); }
  const zb = Math.max(-SZ + 0.7, Math.min(mz0, gz0, ...others.map((r) => r[2])) - 1.6);
  return P([[m.x, mz0], [m.x, zb], [g.x, zb], [g.x, gz0]]);
}
/** 区域里的卡连到别的楼层（回报、楼顶；只在竖起来看时画）：先横着到区域边上的空当，沿空当到区域上沿，再去目标，不从别的卡底下穿 */
function gutterPath(a, b) {
  const g = NB["reg:" + a.sess], f = a.floor, [gx0, gx1, gz0] = rectOf(g);
  const busy = (left) => g.members.some((k) => { const m = NB[k]; return m !== a && Math.abs(m.z - a.z) < (m.h + a.h) / 2 && (left ? m.x < a.x - 1 : m.x > a.x + 1); });
  let left = b.x <= a.x; if (busy(left) && !busy(!left)) left = !left;
  const xg = left ? gx0 + 0.65 : gx1 - 0.65;
  return [...wpt(f, a.x + ((left ? -1 : 1) * a.w) / 2, a.z), ...wpt(f, xg, a.z), ...wpt(f, xg, gz0), ...nodePoint(b, 0.04)];
}
function applyLinks() {
  for (const l of LINKS) {
    const a = NB[l.a], b = NB[l.b]; const h = 0.04;
    let o = Math.min(a.mesh.material.opacity, b.mesh.material.opacity);
    if (!V.on && S.selFloor != null && Math.max(a.floor, b.floor) > S.selFloor) o *= 0.15;
    if (l.kind === "report" || l.kind === "roof") o *= 1 - BV.cur; // 在楼里由立面上的线代替
    const hl = S.sel && (S.sel === l.a || S.sel === l.b || (V.on && V.rel.has(l.a) && V.rel.has(l.b)));
    l.line.visible = o > 0.02; if (!l.line.visible) continue;
    const pts = l.kind === "split" ? splitPath(a, b) : (l.kind === "roof" || l.kind === "report") && a.kind === "sess" ? gutterPath(a, b) : [...nodePoint(a, h), ...nodePoint(b, h)]; const lk = pts.map((v) => v.toFixed(3)).join(); if (l.key !== lk) { l.key = lk; l.line.geometry.dispose(); l.line.geometry = new LineGeometry().setPositions(pts); l.line.computeLineDistances(); }
    l.line.material.opacity = Math.min(1, o * (hl ? 1 : 0.75)); l.line.material.linewidth = hl ? 3.2 : l.kind === "roof" ? 2.4 : 2;
  }
}

/* ================= 竖起来：相关楼层立起来、正对人，从上到下按时间排 ================= */
const GAP = 2.2, STRIP = LABEL_H + 0.5;
function layoutColumn() {
  const relFloors = new Set([...V.rel].map((k) => NB[k].floor));
  const all = [...Array(N).keys()].map((i) => i + 1).concat([ROOF_F]);
  const lo = Math.min(...relFloors), hi = Math.max(...relFloors);
  const list = all.filter((f) => relFloors.has(f) || (V.others === "semi" && f > lo && f < hi));
  let x0 = 1e9, x1 = -1e9; const box = {};
  for (const k of V.rel) { const n = NB[k]; const r = rectOf(n); x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[1]); const b = (box[n.floor] ||= [1e9, -1e9]); b[0] = Math.min(b[0], r[2]); b[1] = Math.max(b[1], r[3]); }
  V.x0 = x0 - 2; V.x1 = Math.max(x1 + 2, x0 - 2 + 46);
  let y = 0; const out = [];
  // 从楼顶往下排：早的楼层在下面，和盖楼一样
  for (const f of [...list].reverse()) { const rel = relFloors.has(f); const z0 = rel ? box[f][0] - LABEL_H - 1.7 : 0, z1 = rel ? box[f][1] + 1.6 : STRIP; const h = z1 - z0; out.push({ f, rel, z0, z1, yTop: y }); y -= h + (rel ? GAP : GAP * 0.6); }
  const total = -y; const mid = [...relFloors].reduce((a, f) => a + Math.min(f, N), 0) / relFloors.size; const top = baseY(Math.round(mid)) + total / 2; // 竖起来的一列放在相关楼层原来的高度附近
  for (const c of out) c.y = top + c.yTop - (c.z1 - c.z0) / 2; // 这块板中心的高度
  V.floors = out; V.cy = top - total / 2; V.h = total;
}
function enterVertical(key) {
  if (!V.on) V.saved = { pivot: [...cam.pivot], yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, floor: S.selFloor };
  V.on = true; V.key = key; V.rel = related(key); S.selFloor = null; layoutColumn(); floorTargets();
  const aspect = W / H, th = Math.tan(pcam.fov * Math.PI / 360), w = V.x1 - V.x0;
  animateTo({ pivot: [(V.x0 + V.x1) / 2, V.cy, 0], yaw: 0, pitch: 0, dist: Math.max(V.h / (2 * th), w / (2 * th * aspect)) * 1.1 + 2 }, 520);
  for (const F of FLOORS.slice(1)) drawLabel(F);
  renderVBar(); renderRail();
}
function exitVertical(keepCam) { if (!V.on) return; V.on = false; if (!keepCam && V.saved) S.selFloor = V.saved.floor ?? null; floorTargets(); if (V.saved && !keepCam) animateTo(V.saved, 520); for (const F of FLOORS.slice(1)) drawLabel(F); renderVBar(); renderRail(); }
function renderVBar() {
  const el = $("vbar"); el.classList.toggle("hidden", !V.on); if (!V.on) return; const n = NB[V.key];
  el.querySelector(".vt").textContent = `竖起来看 · ${n.kind === "region" ? n.title : n.title}`;
  for (const b of el.querySelectorAll("[data-o]")) b.classList.toggle("on", b.dataset.o === V.others);
}

/* ================= 镜头 ================= */
const offsetDir = (y, p) => [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
function camBasis() { const od = offsetDir(cam.yaw, cam.pitch); const pos = cam.pivot.map((v, i) => v + od[i] * cam.dist); const fwd = new THREE.Vector3(-od[0], -od[1], -od[2]); const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(); const up = new THREE.Vector3().crossVectors(right, fwd); return { pos, fwd, right, up }; }
function applyCam() {
  const b = camBasis(); const c = cam.ortho ? ocam : pcam; c.position.set(...b.pos); c.up.set(0, 1, 0); c.lookAt(...cam.pivot);
  if (cam.ortho) { const hh = cam.dist * Math.tan(pcam.fov * Math.PI / 360), ww = hh * W / H; Object.assign(ocam, { left: -ww, right: ww, top: hh, bottom: -hh }); ocam.updateProjectionMatrix(); }
  return c;
}
let anim = null;
function animateTo(t, ms = 360) {
  const from = { pivot: [...cam.pivot], yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist }; const t0 = performance.now();
  let dy = (t.yaw ?? cam.yaw) - from.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
  anim = (now) => { let k = Math.min(1, (now - t0) / ms); k = 1 - Math.pow(1 - k, 3); if (t.pivot) cam.pivot = from.pivot.map((v, i) => v + (t.pivot[i] - v) * k); if (t.yaw != null) cam.yaw = from.yaw + dy * k; if (t.pitch != null) cam.pitch = from.pitch + (t.pitch - from.pitch) * k; if (t.dist != null) cam.dist = from.dist + (t.dist - from.dist) * k; if (k >= 1) anim = null; dirty = true; };
}
/** 首屏：整栋楼（1F 到楼顶）都在画面里。量 8 个角落在屏幕上的位置，二分找刚好放下的远近，再把楼挪到画面中间；上面给立牌留地方，下面给操作提示留地方 */
function home() {
  const yaw = 0, pitch = 0.74, pad = { l: 22, r: 22, t: 70, b: 44 }, od = offsetDir(yaw, pitch), upp0 = (2 * Math.tan(pcam.fov * Math.PI / 360)) / H, f0 = Math.max(1, N - HOME_FLOORS + 1); // 楼高了以后首屏只框最上面这几层：最新的事在上面，往下用电梯或 ↓
  const corners = []; for (const x of [-SX - 1, SX + 1]) { for (const z of [-SZ, SZ + 0.5]) corners.push(new THREE.Vector3(x, baseY(f0) - SLAB_T, z), new THREE.Vector3(x, baseY(N) + 0.5, z)); corners.push(new THREE.Vector3(x, baseY(ROOF_F) + 0.5, SZ - ROOF_D), new THREE.Vector3(x, baseY(ROOF_F) + 0.5, SZ + 0.5)); }
  const measure = (pv, d) => { pcam.position.set(pv[0] + od[0] * d, pv[1] + od[1] * d, pv[2] + od[2] * d); pcam.up.set(0, 1, 0); pcam.lookAt(pv[0], pv[1], pv[2]); pcam.updateMatrixWorld(); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of corners) { _p1.copy(p).project(pcam); const sx = ((_p1.x + 1) / 2) * W, sy = ((1 - _p1.y) / 2) * H; x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); } return [x0, x1, y0, y1]; };
  let pivot = [0, (baseY(f0) + baseY(ROOF_F)) / 2, 0], dist = 200; const aw = Math.max(60, W - pad.l - pad.r), ah = Math.max(60, H - pad.t - pad.b);
  for (let it = 0; it < 4; it++) {
    let lo = 20, hi = 1200; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2, m = measure(pivot, mid); if (m[1] - m[0] <= aw && m[3] - m[2] <= ah) hi = mid; else lo = mid; } dist = hi;
    const m = measure(pivot, dist), dx = (m[0] + m[1]) / 2 - (pad.l + aw / 2), dy = (m[2] + m[3]) / 2 - (pad.t + ah / 2);
    pivot = [pivot[0] + dx * upp0 * dist, pivot[1] - (dy * upp0 * dist) / Math.cos(pitch), 0];
  }
  HOME = { pivot, yaw, pitch, dist };
}
let touched = false; // 人动过镜头没有：没动过时，窗口变大小就重新定首屏（在 Studio 查看器里页面可能先以很小的尺寸加载）
function resize() {
  const r = wrap.getBoundingClientRect(); W = r.width; H = r.height; if (!(W > 0 && H > 0)) return;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1)); renderer.setSize(W, H, false); pcam.aspect = W / H; pcam.updateProjectionMatrix();
  for (const l of LINKS) l.line.material.resolution.set(W, H); for (let f = 1; f <= ROOF_F; f++) FLOORS[f].outline.material.resolution.set(W, H); for (const n of NODES) if (n.sign) n.sign.lead.material.resolution.set(W, H);
  for (const L of XLINES) L.material.resolution.set(W, H);
  home(); if (!touched) Object.assign(cam, { ...HOME, pivot: [...HOME.pivot] });
  dirty = true;
}

/* ================= 坐标轴小部件（2D 叠在右上角） ================= */
const gz = $("gizmo"), gctx = gz.getContext("2d"); let gizmoHits = [];
function drawGizmo() {
  const dpr = devicePixelRatio || 1; gz.width = 120 * dpr; gz.height = 130 * dpr; gctx.setTransform(dpr, 0, 0, dpr, 0, 0); gctx.clearRect(0, 0, 120, 130);
  const b = camBasis(); const gx = 60, gy = 52, r = 32; gizmoHits = [];
  const axes = [{ a: [1, 0, 0], n: "X", c: C.crit }, { a: [0, 1, 0], n: "Y", c: C.good }, { a: [0, 0, 1], n: "Z", c: C.s2 }]; const ends = [];
  for (const ax of axes) for (const sg of [1, -1]) { const v = new THREE.Vector3(...ax.a).multiplyScalar(sg); ends.push({ ax, sg, x: gx + v.dot(b.right) * r, y: gy - v.dot(b.up) * r, z: v.dot(b.fwd), v: v.toArray() }); }
  ends.sort((a, b2) => b2.z - a.z); gctx.fillStyle = C.surface; gctx.globalAlpha = 0.75; gctx.beginPath(); gctx.arc(gx, gy, r + 13, 0, Math.PI * 2); gctx.fill(); gctx.globalAlpha = 1;
  for (const e of ends) { gctx.strokeStyle = e.sg > 0 ? e.ax.c : C.text3; gctx.lineWidth = e.sg > 0 ? 2.5 : 1.2; gctx.beginPath(); gctx.moveTo(gx, gy); gctx.lineTo(e.x, e.y); gctx.stroke(); gctx.fillStyle = e.sg > 0 ? e.ax.c : C.neutral; gctx.beginPath(); gctx.arc(e.x, e.y, e.sg > 0 ? 9 : 6, 0, Math.PI * 2); gctx.fill(); if (e.sg > 0) { gctx.fillStyle = "#fff"; gctx.font = `700 10px ${C.sans}`; gctx.textAlign = "center"; gctx.textBaseline = "middle"; gctx.fillText(e.ax.n, e.x, e.y + 0.5); } gizmoHits.push({ x: e.x, y: e.y, r: 10, v: e.v }); }
  gctx.fillStyle = C.surface2; gctx.strokeStyle = C.text3; gctx.lineWidth = 1; gctx.beginPath(); gctx.arc(gx, gy, 7, 0, Math.PI * 2); gctx.fill(); gctx.stroke(); gizmoHits.push({ x: gx, y: gy, r: 8, center: true });
  gctx.fillStyle = C.text2; gctx.font = `600 11px ${C.sans}`; gctx.textAlign = "center"; gctx.textBaseline = "alphabetic"; gctx.fillText(cam.ortho ? "Iso" : "Persp", gx, gy + r + 24);
}
gz.addEventListener("mousedown", (e) => { const r = gz.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const g = gizmoHits.find((h) => Math.hypot(h.x - mx, h.y - my) <= h.r); if (!g) return; e.stopPropagation(); if (g.center) { cam.ortho = !cam.ortho; dirty = true; } else { const v = g.v; animateTo({ yaw: v[1] ? cam.yaw : Math.atan2(v[0], v[2]), pitch: v[1] ? (v[1] > 0 ? Math.PI / 2 - 0.001 : -Math.PI / 2 + 0.001) : 0 }); } });

/* ================= 点选、拖动、操作 ================= */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pickAt(mx, my) {
  ndc.set((mx / W) * 2 - 1, -(my / H) * 2 + 1); ray.setFromCamera(ndc, cam.ortho ? ocam : pcam);
  const hits = ray.intersectObjects(pickables.filter((o) => { let p = o; while (p) { if (!p.visible) return false; p = p.parent; } const m = Array.isArray(o.material) ? o.material[2] : o.material; return m.opacity > 0.3; }), false);
  // 卡片和区域在楼板上面一点点，射线先碰到谁就是谁；区域里点到卡片时卡片优先
  const first = hits[0]; if (!first) return null; const k = first.object.userData.key;
  if (k.startsWith("reg:")) { const card = hits.find((h) => NB[h.object.userData.key] && NB[h.object.userData.key].kind !== "region" && Math.abs(h.distance - first.distance) < 0.5); if (card) return card.object.userData.key; }
  return k;
}
function floorHit(mx, my, y) { ndc.set((mx / W) * 2 - 1, -(my / H) * 2 + 1); ray.setFromCamera(ndc, cam.ortho ? ocam : pcam); const p = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null; }
let drag = null; const keys = {};
cv.addEventListener("contextmenu", (e) => e.preventDefault());
cv.addEventListener("mousedown", (e) => {
  cv.focus(); touched = true; const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; let mode = null, key = null, grab = null;
  if (e.button === 0) { if (e.altKey) mode = e.ctrlKey ? "pan" : "orbit"; else { key = pickAt(mx, my); mode = key && NB[key] && !V.on ? "node" : "click"; if (mode === "node") { const n = NB[key]; const h = floorHit(mx, my, FLOORS[n.floor].cur.py); if (h) grab = [h.x - n.x, h.z - n.z]; } } }
  else if (e.button === 1) { mode = "pan"; e.preventDefault(); } else if (e.button === 2) mode = e.altKey ? "zoom" : "look";
  drag = { mode, key, grab, x: e.clientX, y: e.clientY, sx: mx, sy: my, moved: false };
});
function tipFor(k) { if (!k) return null; if (k.startsWith("sign:")) return "点牌子：选中这件事并打开对话"; if (k.startsWith("floor:")) return null; const n = NB[k]; return n ? `${n.title} · ${n.desc}` : null; }
function setHover(k) { const hk = k && k.startsWith("sign:") ? k.slice(5) : k; if (hk === S.hover) return; const old = S.hover; S.hover = hk; for (const key of [old, hk]) { const n = key && NB[key]; if (n) n.kind === "region" ? drawRegion(n) : drawCard(n); } dirty = true; }
const tip = $("tip");
window.addEventListener("mousemove", (e) => {
  if (!drag && e.target.closest && e.target.closest(".sign")) { tip.classList.add("hidden"); return; } const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (!drag) { if (mx < 0 || my < 0 || mx > W || my > H) { setHover(null); tip.classList.add("hidden"); return; } const k = pickAt(mx, my); setHover(k && !k.startsWith("floor:") ? k : null); const t = tipFor(k);
    if (t) { tip.textContent = t; tip.classList.remove("hidden"); tip.style.left = Math.min(W - 20, mx + 14) + "px"; tip.style.top = my + 18 + "px"; } else tip.classList.add("hidden"); cv.style.cursor = k ? (NB[k] && !V.on ? "grab" : "pointer") : "default"; return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; if (Math.abs(mx - drag.sx) + Math.abs(my - drag.sy) > 3) drag.moved = true; const k = 0.0055;
  if (drag.mode === "node") { if (!drag.moved) return; const n = NB[drag.key]; const h = floorHit(mx, my, FLOORS[n.floor].cur.py); if (h && drag.grab) { const nx = h.x - drag.grab[0], nz = h.z - drag.grab[1]; moveNode(n, nx, nz); cv.style.cursor = "grabbing"; } }
  else if (drag.mode === "orbit") { cam.yaw -= dx * k; cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch + dy * k)); }
  else if (drag.mode === "look") { const b = camBasis(); cam.yaw -= dx * k * 0.7; cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch + dy * k * 0.7)); const od = offsetDir(cam.yaw, cam.pitch); cam.pivot = b.pos.map((v, i) => v - od[i] * cam.dist); }
  else if (drag.mode === "pan") { const b = camBasis(); const upp = (2 * cam.dist * Math.tan(pcam.fov * Math.PI / 360)) / H; cam.pivot = cam.pivot.map((v, i) => v - b.right.getComponent(i) * dx * upp + b.up.getComponent(i) * dy * upp); }
  else if (drag.mode === "zoom") cam.dist = Math.max(8, Math.min(2500, cam.dist * Math.exp(-(dx - dy) * 0.006)));
  if (drag.mode !== "click") { setHover(null); tip.classList.add("hidden"); } dirty = true;
});
/** 拖卡片：限在楼板里；卡片在区域里时区域跟着变大变小；拖区域时里面的卡一起走 */
function moveNode(n, nx, nz) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  if (n.kind === "region") { const dx = clamp(nx, -SX + n.w / 2, SX - n.w / 2) - n.x, dz = clamp(nz, -SZ + n.h / 2, SZ - n.h / 2) - n.z; for (const k of n.members) { const m = NB[k]; m.x += dx; m.z += dz; placeNode(m); } regionFit(n); placeNode(n); }
  else { n.x = clamp(nx, -SX + n.w / 2 + 0.6, SX - n.w / 2 - 0.6); n.z = clamp(nz, -SZ + n.h / 2 + 0.6, SZ - n.h / 2 - 0.6); placeNode(n); const g = NODES.find((r) => r.kind === "region" && r.members.includes(n.key)); if (g) { regionFit(g); drawRegion(g); placeNode(g); } }
  layoutRisers(); dirty = true;
}
window.addEventListener("mouseup", () => {
  if (!drag) return; const d = drag; drag = null;
  if (d.mode === "node" && d.moved) return; // 拖过的卡片只在这一次打开里算数：区域是自动摆的，存下来的位置下次会和新卡叠在一起
  if (d.moved || (d.mode !== "click" && d.mode !== "node")) return; const k = pickAt(d.sx, d.sy);
  if (!k) { select(null); exitVertical(); return; }
  if (k.startsWith("sign:")) { select(k.slice(5)); return; }
  // 点楼层名：去那一层，并在会话弹窗里打开那一轮（楼层名就是这一轮的标题；它的卡片多半被上一层挡着）
  if (k.startsWith("floor:")) { if (V.on) return; const f = +k.slice(6); select(null, true); goFloor(f); post(f <= N ? pickOf("m" + f) : { type: "tower.unpick" }); return; }
  select(k);
});
cv.addEventListener("dblclick", (e) => { const r = cv.getBoundingClientRect(); const k = pickAt(e.clientX - r.left, e.clientY - r.top); if (k && NB[k]) openSrc(k); });
cv.addEventListener("wheel", (e) => { e.preventDefault(); touched = true; cam.dist = Math.max(8, Math.min(2500, cam.dist * (1 + Math.sign(e.deltaY) * 0.12))); dirty = true; }, { passive: false });
cv.addEventListener("keydown", (e) => { const k = e.key.toLowerCase(); keys[k] = true; keys.shift = e.shiftKey; });
cv.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; keys.shift = e.shiftKey; });
cv.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
window.addEventListener("keydown", (e) => {
  if (drag) return;
  if (e.key === "Escape") { if (V.on) { exitVertical(); select(null); } else { select(null); goFloor(null); } return; }
  if (!V.on && (e.key === "ArrowUp" || e.key === "ArrowDown")) { const cur = S.selFloor ?? (e.key === "ArrowUp" ? 0 : ROOF_F + 1); const f = cur + (e.key === "ArrowUp" ? 1 : -1); if (f >= 1 && f <= ROOF_F) { select(null); goFloor(f); } e.preventDefault(); }
});
/** 去某一层：镜头方向、远近不动（人转好的视角留着），只上下平移；上面的楼层升起来、藏掉（用户 2026-11-16：选中楼层后，楼层之上直接隐藏吧，半透明有点怪） */
function goFloor(f, from) { if (f) touched = true; S.selFloor = f; floorTargets(); const b = from || cam; if (f) animateTo({ pivot: [b.pivot[0], baseY(f) + 1, b.pivot[2]], yaw: b.yaw, pitch: b.pitch, dist: b.dist }, from ? 520 : 360); for (const F of FLOORS.slice(1)) drawLabel(F); renderRail(); renderSide(); }

/* ================= 循环：只在有变化时画 ================= */
let last = performance.now(), frames = 0, fpsT = last, lastChange = 0, resPending = false, lastCam = null;
function loop(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  if (drag && drag.mode === "look") { const b = camBasis(); const sp = (keys.shift ? 70 : 24) * dt; const mv = new THREE.Vector3(); if (keys.w) mv.addScaledVector(b.fwd, sp); if (keys.s) mv.addScaledVector(b.fwd, -sp); if (keys.d) mv.addScaledVector(b.right, sp); if (keys.a) mv.addScaledVector(b.right, -sp); if (keys.e) mv.y += sp; if (keys.q) mv.y -= sp; if (mv.lengthSq()) { cam.pivot = cam.pivot.map((v, i) => v + mv.getComponent(i)); dirty = true; } }
  if (anim) anim(t);
  const moving = FLOORS[1] && stepFloors(dt);
  if ((dirty || moving) && W > 0 && H > 0) { dirty = false; applyFloors(); applyLinks(); applyRisers(); const c = applyCam(); c.updateMatrixWorld(); updateSigns(c); updatePins(c); renderer.render(scene, c); drawGizmo(); frames++; lastCam = c; if (anim || (moving && settling) || drag) { lastChange = t; resPending = true; } else if (!resPending) { resPending = true; lastChange = t; } }
  // 停下来 150ms 以后再按屏幕大小重画贴图，转镜头的过程中不重画
  if (resPending && lastCam && !anim && !drag && t - lastChange > 150) { resPending = refreshRes(lastCam); dirty = true; if (!resPending) lastChange = Infinity; }
  if (t - fpsT > 1000) { window.__tracksFps = frames; frames = 0; fpsT = t; }
  requestAnimationFrame(loop);
}

/* ================= 电梯 ================= */
function floorMarks(f) { if (f === ROOF_F) return D.roof.some((it) => it.s === "you") ? ["you"] : D.roof.length ? ["other"] : []; const s = new Set(); for (const n of NODES.filter((n) => n.floor === f && n.kind !== "region")) for (const it of n.items || []) if (it.s === "you" || it.s === "other") s.add(it.s); return [...s]; }
/**
 * 楼层导航在场景右上角，只列一小段（用户 2026-11-16：楼层导航改到右上角，而且一上来就展示了全部楼层，我觉得效果不太好）：
 * 楼顶 + 连着的 RAIL_N 层，▲ ▼ 或滚轮翻；选中的楼层不在这一段里时这一段跟过去。上面、下面没列出来的楼层里有等着的事，▲ ▼ 上带点。
 */
const RAIL_N = 6;
let railTop = null; // 这一段最上面是哪一层；null = 跟着最新的几层
function railWindow() { const top = Math.max(Math.min(RAIL_N, N), Math.min(N, railTop ?? N)); return { top, bottom: Math.max(1, top - RAIL_N + 1) }; }
function railMove(d) { const { top } = railWindow(); const t = Math.max(Math.min(RAIL_N, N), Math.min(N, top + d)); railTop = t >= N ? null : t; renderRail(true); }
function renderRail(keep) {
  const el = $("rail"); const inCol = (f) => V.on && V.floors.some((x) => x.f === f && x.rel);
  // 选中的那一层（或竖起来的那几层里最高的）不在这一段里：这一段跟过去，把它放在中间
  const cur = S.selFloor && S.selFloor <= N ? S.selFloor : V.on ? Math.max(0, ...V.floors.filter((x) => x.rel && x.f <= N).map((x) => x.f)) : 0;
  if (!keep && cur) { const w = railWindow(); if (cur > w.top || cur < w.bottom) { const t = Math.min(N, cur + Math.floor(RAIL_N / 2)); railTop = t >= N ? null : t; } }
  const { top, bottom } = railWindow(); const fl = [ROOF_F, ...Array.from({ length: top - bottom + 1 }, (_, i) => top - i)];
  const mark = (list) => { const m = new Set(list.flatMap(floorMarks)); return m.has("you") ? '<i class="d you"></i>' : m.has("other") ? '<i class="d other"></i>' : ""; };
  const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
  const more = (dir, list, label) => `<button class="more" data-d="${dir}" ${list.length ? "" : "disabled"} title="${list.length ? `${label}还有 ${list.length} 层` : `${label}没有了`}">${dir > 0 ? "▲" : "▼"}${mark(list)}</button>`;
  el.innerHTML = `<div class="cap" title="一轮一层，最新的在上面">共 ${N} 层</div>` +
    fl.slice(0, 1).map((f) => `<button data-f="${f}" class="roof ${S.selFloor === f || inCol(f) ? "on" : ""}" title="楼顶 · 现在还没完的事">顶${floorMarks(f).slice(0, 1).map((m) => `<i class="d ${m}"></i>`).join("")}</button>`).join("") +
    (N > RAIL_N ? more(1, range(top + 1, N), "上面") : "") +
    fl.slice(1).map((f) => `<button data-f="${f}" class="${S.selFloor === f || inCol(f) ? "on" : ""}" title="${f}F · ${esc(ROUND(f).title)}">${f}${floorMarks(f).slice(0, 1).map((m) => `<i class="d ${m}"></i>`).join("")}</button>`).join("") +
    (N > RAIL_N ? more(-1, range(1, bottom - 1), "下面") : "");
  for (const b of el.querySelectorAll("button[data-f]")) b.onclick = () => { const sv = V.on ? V.saved : null; exitVertical(true); select(null); goFloor(+b.dataset.f, sv); };
  for (const b of el.querySelectorAll("button[data-d]")) b.onclick = () => railMove(+b.dataset.d * RAIL_N);
}
$("rail").addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); railMove(e.deltaY < 0 ? 1 : -1); }, { passive: false });

/* ================= 右边检视 ================= */
/**
 * 选中一张卡片、一块区域或楼顶的一件事。它的内容不在右边栏里显示了（用户 2026-11-16：点击某个卡片时，不要用侧边栏展示应该改成会话弹窗）：
 * 告诉外面的页面（tower.pick），由它在楼上面开会话弹窗——真的对话，滚到这一行，输入框也在里面。取消选中时说 tower.unpick（弹窗没固定就关）。
 * quiet：外面的页面自己关了弹窗、或者紧接着要报另一件事时，不再往外说。
 */
function select(k, quiet) {
  const old = S.sel; S.sel = k || null; if (k) touched = true;
  for (const key of [old, S.sel]) { const n = key && NB[key]; if (n) n.kind === "region" ? drawRegion(n) : drawCard(n); }
  const n = k && NB[k];
  if (n && $("autoV").checked) { enterVertical(k); } else if (!n) { /* 取消选中：留在原处 */ }
  renderSide(); dirty = true;
  if (!quiet) post(n ? pickOf(k) : { type: "tower.unpick" });
}
/** 要点：AI 用 track_note 记下的「人强调的事、谈定的结论」。还开着的在上面，处理完的折起来 */
function pointsHTML() {
  const open = D.points.filter((p) => !p.done), done = D.points.filter((p) => p.done);
  const li = (p) => `<li data-f="${p.round || ""}" title="${p.round ? "记在 " + p.round + "F，点一下去那一层" : ""}"><span class="g ${p.done ? "done" : "ai"}">${p.done ? "✓" : "○"}</span><span>${esc(p.text)}${p.round ? ` <em>${p.round}F</em>` : ""}</span></li>`;
  if (!D.points.length) return `<p class="meta">还没有。${D.on ? "AI 会把你强调的事、谈定的结论记在这里。" : "把这个会话设成脉络会话后，AI 会把你强调的事、谈定的结论记在这里。"}</p>`;
  return `${open.length ? `<ul class="todo pts">${open.map(li).join("")}</ul>` : `<p class="meta">没有还开着的要点。</p>`}${done.length ? `<details class="work"><summary>已处理 ${done.length} 条</summary><ul class="todo pts">${done.map(li).join("")}</ul></details>` : ""}`;
}
/** 右边栏只放总览：要点、楼顶的事、子会话。点其中一项 = 选中它（竖起来 + 会话弹窗） */
function renderSide() {
  const el = $("sideBody"); const unl = D.rounds.filter((r) => !r.labelled).length;
  el.innerHTML = `<span class="chip">这个会话</span><h3>${esc(D.title)}</h3><p class="desc">${N} 轮${D.sessions.length ? `，开过 ${D.sessions.length} 个子会话` : ""}。一轮一层，最新的在上面；楼顶是现在还没完的事。点楼层名或卡片，在弹出的会话窗口里看那一轮。${unl ? `有 ${unl} 层的标题是从对话里截的（AI 没写）。` : ""}</p>
    <h4>要点 · AI 记下的</h4>${pointsHTML()}
    <h4>楼顶 · 现在还没完的事</h4>${D.roof.length ? `<div class="cards">${D.roof.map((it) => `<div class="ocard ${it.s} ${S.sel === it.key ? "on" : ""}" data-k="${esc(it.key)}"><div class="t">${GLYPH[it.s]} ${esc(it.title)}</div><div class="s">${esc(it.desc)}</div></div>`).join("")}</div>` : `<p class="meta">现在没有等着的事。</p>`}
    ${D.sessions.length ? `<h4>子会话</h4><div class="cards">${D.sessions.map((s) => `<div class="ocard ${S.sel === "reg:" + s.key ? "on" : ""}" data-k="reg:${s.key}"><div class="t"><span class="chip sess">${s.key}</span> ${esc(s.title)}</div><div class="s">${s.at}F 开的 · ${s.total} 轮 · ${GLYPH[s.state.s]} ${esc(s.state.t)}</div></div>`).join("")}</div>` : ""}`;
  for (const c of el.querySelectorAll("[data-k]")) c.onclick = () => select(c.dataset.k);
  for (const c of el.querySelectorAll("li[data-f]")) if (c.dataset.f) c.onclick = () => { exitVertical(true); select(null); goFloor(Math.min(N, +c.dataset.f)); };
}

/* ================= 去对话里看：告诉外面的页面打开哪个会话、跳到哪一行（原型里的会话浮窗换成真的对话） ================= */
/** 一张卡片对应哪个会话的哪一行：主会话的一轮、回报、楼顶的事是这栋楼自己的会话；子会话的区域和它的各轮是那个子会话 */
function pickOf(k) {
  // title：卡片自己的话（哪一层、这一轮的标题），外面的弹窗把它写在会话名后面；整个子会话的区域没有（会话名就够了）
  const n = NB[k]; const m = { type: "tower.pick", sessionId: D.sessionId, title: n.kind === "region" ? "" : n.kind === "main" || n.kind === "ask" ? `${n.round}F · ${n.title || ""}` : n.title || "" };
  const sub = (s) => { m.sessionId = s.sessionId; return s; };
  if (n.kind === "roof") { const it = n.ref, o = NB[it.origin], s = it.sessionId && D.sessions.find((x) => x.sessionId === it.sessionId); if (s) sub(s); else if (it.sessionId) m.sessionId = it.sessionId; else m.itemId = it.itemId || (o?.sess === "main" ? ROUND(o.round)?.itemId : undefined); }
  else if (n.kind === "region") sub(SESS[n.sess]);
  else if (n.kind === "sess") m.itemId = sub(SESS[n.sess]).rounds.find((c) => c.n === n.round)?.itemId;
  else if (n.kind === "report") m.itemId = REP[n.key].itemId;
  else m.itemId = ROUND(n.round).itemId;
  if (!m.itemId) delete m.itemId;
  if (!m.title) delete m.title;
  return m;
}
/** 双击卡片：离开脉络，到对话视图里看这一行 */
function openSrc(k) { if (!NB[k]) return; const { title: _t, ...m } = pickOf(k); if (m.sessionId === D.sessionId) delete m.sessionId; post({ ...m, type: "tower.open" }); }

/* ================= 顶栏、右边栏的开合、主题 ================= */
function showSide(on) { document.querySelector(".ed").classList.toggle("noside", !on); $("sideBtn").classList.toggle("on", on); }
$("sideBtn").onclick = () => showSide(document.querySelector(".ed").classList.contains("noside"));
$("sideClose").onclick = () => showSide(false);
$("resetCam").onclick = () => { exitVertical(); select(null); goFloor(null); V.saved = null; animateTo(HOME); touched = false; };
for (const b of document.querySelectorAll("#vbar [data-o]")) b.onclick = () => { V.others = b.dataset.o; if (V.on) enterVertical(V.key); renderVBar(); };
$("vback").onclick = () => { exitVertical(); select(null); };
const recolor = () => { applyTheme(); readColors(); applyColors(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolor);
addEventListener("storage", (e) => { if (e.key === "amo.theme") recolor(); });

/* ================= 开始 ================= */
readColors(); buildNodes(); buildScene();
for (let f = 1; f <= ROOF_F; f++) FLOORS[f].tgt = null;
floorTargets();
// 上次看到哪（这个窗口里）：镜头留在原处；这期间楼长高了、又没停在某一层上，就跟着往上挪
const saved = sstore.get(VIEW_KEY);
if (saved?.cam) { Object.assign(cam, saved.cam); if (saved.n !== N && saved.selFloor == null) cam.pivot = [cam.pivot[0], cam.pivot[1] + (N - saved.n) * FH, cam.pivot[2]]; touched = true; }
showSide(saved ? !!saved.side : innerWidth >= 1000);
function saveView() { sstore.set(VIEW_KEY, { cam: touched ? { pivot: [...cam.pivot], yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, ortho: cam.ortho } : null, n: N, selFloor: S.selFloor, sel: S.sel, side: !document.querySelector(".ed").classList.contains("noside") }); }
addEventListener("pagehide", () => { try { saveView(); } catch {} });
window.addEventListener("resize", resize); new ResizeObserver(resize).observe(wrap); resize();
renderRail(); renderSide(); requestAnimationFrame(loop);
// 画布上的字不会自己等字体：字体到了以后全部重画一遍
document.fonts?.load(`700 16px ${C.sans}`, (NODES.map((n) => (n.title || "") + (n.desc || "")).join("") + "楼顶现在还没完的事子会话回报等你审批回答").slice(0, 8000)).then(() => applyColors()).catch(() => {});
// 给端到端测试和截图用
window.__tower = { data: D, S, V, cam, NB, RISERS, FLOORS, select, goFloor, enterVertical, exitVertical, openSrc, poke() { dirty = true; }, get home() { return HOME; }, get ready() { return W > 0 && !!HOME; },
  screenOf(key) { const n = NB[key]; const F = FLOORS[n.floor]; F.g.updateMatrixWorld(); const p = F.g.localToWorld(new THREE.Vector3(n.x, 0.06, n.z)); const c = cam.ortho ? ocam : pcam; p.project(c); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H]; } };
