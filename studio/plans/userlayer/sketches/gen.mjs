// 全景「区域和线路」概念图（2026-11-03）：按种子程序化生成几个方向 × 远景、中景的 SVG，纯视觉探索。
// 用户嫌胶囊底座不好看，要区域和线路既能分区（像地图），又有不规律的美感。不规则的形状全由噪声、距离场、
// marching squares、Voronoi 算出来，不手写坐标，选定的方向以后好搬进 deck.gl（同一套场 → 多边形 / 点）。
// 用法：node studio/plans/userlayer/sketches/gen.mjs [--seeds 7,13,21] [--only terrain,metro]
// 输出：同目录 <方向>-far-<种子>.svg，中景只出第一个种子 <方向>-mid-<种子>.svg；入口页是上一级的 sketches.html。
// 11-03 用户定了地形岛（terrain）和地铁（metro），默认只出这两个；等高线、群岛、Voronoi、点阵的代码留着，--only 还能出。
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
// --seeds 7,13,21：每个种子出一张远景，中景只出第一个种子的
const SEEDS = arg("--seeds", arg("--seed", "7")).split(",").map(Number);
let SEED = SEEDS[0];
const ONLY = arg("--only", "").split(",").filter(Boolean);

// ---------------- 随机和噪声 ----------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function makeNoise(seed) {
  const r = rng(seed), perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const p = new Uint8Array(512); for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const grad = (h, x, y) => { const g = G[h & 7]; return g[0] * x + g[1] * y; };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255, u = fade(xf), v = fade(yf);
    const aa = p[p[xi] + yi], ab = p[p[xi] + yi + 1], ba = p[p[xi + 1] + yi], bb = p[p[xi + 1] + yi + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return x1 + v * (x2 - x1);
  };
}
// 大致落在 [-1, 1]
const fbm = (n, x, y, oct = 4, gain = 0.5) => { let s = 0, a = 1, f = 1, t = 0; for (let i = 0; i < oct; i++) { s += a * n(x * f + i * 17.3, y * f - i * 9.1); t += a; a *= gain; f *= 2.03; } return (s / t) * 1.9; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------- 假数据（用户 11-03 给的四个专题） ----------------
const TOPICS = [
  { id: "amo", name: "AMO迭代", projects: [
    { name: "AgentMonitorOverlay", lanes: [
      { name: "日常维护", rounds: 14, running: true, remain: 3 },
      { name: "全景", rounds: 9, running: true, remain: 4, subs: [{ from: 3, len: 4, merge: true }, { from: 6, len: 3, running: true }] },
      { name: "新手引导", rounds: 5, remain: 3 },
      { name: "tailscale 转发", rounds: 3, remain: 0, review: true },
      { name: "便签待办", rounds: 7, remain: 2 },
      { name: "中转", rounds: 4, remain: 3 },
    ] },
  ] },
  { id: "mining", name: "mining 迭代", projects: [
    { name: "project_mining", lanes: [
      { name: "文档架构", rounds: 12, remain: 2, wait: [12], subs: [{ from: 4, len: 5, merge: true }] },
      { name: "数据清洗", rounds: 8, running: true, remain: 3 },
      { name: "指标看板", rounds: 6, remain: 4 },
    ] },
    { name: "mining-docs", lanes: [
      { name: "规范整理", rounds: 5, remain: 3, wait: [5] },
      { name: "术语表", rounds: 4, remain: 2, subs: [{ from: 2, len: 3, abandoned: true }] },
    ] },
    { name: "mining-tools", lanes: [
      { name: "采集脚本", rounds: 9, remain: 2, running: true, subs: [{ from: 5, len: 3, running: true }] },
      { name: "导出", rounds: 3, remain: 3 },
    ] },
  ] },
  { id: "web", name: "官网改版", projects: [
    { name: "website", lanes: [{ name: "首页", rounds: 6, running: true, remain: 2 }, { name: "文档站", rounds: 4, remain: 3 }] },
  ] },
  { id: "art", name: "美术资源管线", projects: [
    { name: "asset-lib", lanes: [{ name: "导入器", rounds: 7, done: true }] },
    { name: "render-farm", lanes: [{ name: "批处理", rounds: 5, running: true, remain: 3 }, { name: "预览图", rounds: 3, remain: 4 }] },
  ] },
];

// ---------------- 专题内的布局（直线为主，地铁方向才有 45° 转折） ----------------
const ROW = 30, SUBROW = 22, PGAP = 56, X0 = 170;
// 11-03 第三轮（用户嫌左直右梳）：轮廓的形状另由「只进场」的块决定（shape）：每个项目带左边伸出一块随机长短的地（lobe），
// 右边按整条项目带的外包算（env），不贴着每条 lane 的末端；地铁方向各项目带整体左右错开（shift）。
// 元素标记：shape 只进扭曲后的场；lane 是线路（托底只看它）；其余（牌子、脊、连接）是 core，保证在陆地上。
function layoutTopic(t, ox, oy, metro, ti = 0) {
  const P = (x, y) => [ox + x, oy + y];
  const groups = [], lanes = [], cards = [], bands = [];
  const rr = rng(SEED * 97 + ti * 13 + 5);
  const shifts = t.projects.map(() => { const v = Math.round(rr() * 40); return metro ? v : 0; });
  const lobes = t.projects.map(() => 12 + rr() * 64), headLobe = 12 + rr() * 50;
  const off = Math.floor(rr() * 2);
  let y = 0;
  t.projects.forEach((pr, pi) => {
    const sh = shifts[pi];
    const rows = []; let bottom = y;
    for (const ln of pr.lanes) { rows.push(y); const ns = ln.subs?.length || 0; bottom = y + ns * SUBROW; y += ROW + ns * SUBROW; }
    const hubY = (rows[0] + bottom) / 2;
    const els = [];
    const card = { x: ox + 20 + sh, y: oy + hubY - 18, w: 108, h: 36, pr, pi, hub: P(134 + sh, hubY), waits: pr.lanes.reduce((s, l) => s + (l.wait?.length || 0), 0) };
    cards.push(card); els.push({ rect: [card.x, card.y, card.w, card.h], lane: true });
    pr.lanes.forEach((ln, li) => {
      const ry = rows[li], n = ln.rounds, dx = Math.min(26, 290 / Math.max(n - 1, 1));
      let x0 = X0 + sh, pre;
      if (metro) {
        // 从始发站出来是一束平行的轨道（间距 3.5），上半边最上面的先拐、下半边最下面的先拐，互不交叉
        const nl = pr.lanes.length, off = (li - (nl - 1) / 2) * 3.5, by = hubY + off, dy = ry - by;
        const rank = dy < 0 ? li : dy > 0 ? nl - 1 - li : nl;
        const sx = 144 + sh + rank * 9;
        x0 = Math.max(X0 + sh, sx + Math.abs(dy) + 16);
        pre = [P(134 + sh, by), P(sx, by), P(sx + Math.abs(dy), ry)];
      }
      else pre = [P(x0 - 16, ry)];
      const nodes = []; for (let k = 1; k <= n; k++) nodes.push({ p: P(x0 + (k - 1) * dx, ry), k, wait: !!ln.wait?.includes(k) });
      const front = nodes[n - 1];
      const end = P(ln.done ? x0 + n * dx : x0 + (n - 1) * dx + dx * (1.4 + (ln.remain ?? 2)), ry);
      const subs = (ln.subs || []).map((s, si) => {
        // 支线：从开它的那一轮 45° 斜下去，平行往前；并回时 45° 斜回主干
        const dy = SUBROW * (si + 1), sy = ry + dy, b = nodes[s.from - 1];
        const m = s.merge ? nodes[s.from + s.len] : null;
        const dxs = m ? Math.min(dx, (m.p[0] - b.p[0] - 2 * dy - 6) / Math.max(s.len - 1, 1)) : dx;
        const sn = []; for (let k = 1; k <= s.len; k++) sn.push({ p: [b.p[0] + dy + (k - 1) * dxs, oy + sy], k: s.from + k });
        const path = [b.p, ...sn.map((q) => q.p)];
        if (m) path.push([m.p[0] - dy, oy + sy], m.p);
        return { ...s, nodes: sn, path, branch: b, merge: m };
      });
      lanes.push({ name: ln.name, pi, ry: oy + ry, pre, nodes, front, end, done: !!ln.done, review: !!ln.review, running: !!ln.running, subs });
      const main = [...pre, nodes[0].p, end];
      for (let i = 0; i < main.length - 1; i++) els.push({ seg: [...main[i], ...main[i + 1]], lane: true });
      // 只进场、不画：任务从主控脊出发（11-03 定），脊和任务起点之间不该空出湖来
      els.push({ seg: [ox + 6, oy + ry, ox + X0 + sh - 16, oy + ry] });
      for (const s of subs) for (let i = 0; i < s.path.length - 1; i++) els.push({ seg: [...s.path[i], ...s.path[i + 1]], lane: true });
    });
    // 主控脊在这个项目那一段算进项目（只进场），主控区就只剩上面那一条：头、规范、公告板
    els.push({ seg: [ox + 6, oy + rows[0] - ROW / 2, ox + 6, oy + bottom + ROW / 2] });
    const end = Math.max(...lanes.filter((l) => l.pi === pi).map((l) => Math.max(l.end[0], ...l.subs.map((q) => q.path[q.path.length - 1][0]))));
    els.push({ rect: [ox + X0 + sh - 16, oy + rows[0] - 10, end - (ox + X0 + sh - 16), bottom - rows[0] + 20], shape: true });
    els.push({ rect: [ox + 6 - lobes[pi], oy + rows[0] - 4, lobes[pi], bottom - rows[0] + 8], shape: true });
    bands.push({ top: oy + rows[0], bottom: oy + bottom, shift: sh, end });
    groups.push({ name: pr.name, els, pi });
    y = bottom + PGAP;
  });
  const lastY = y - PGAP;
  const spine = { x: ox + 6, y0: oy - 92, y1: oy + lastY + 10 };
  const header = { x: ox, y: oy - 150, w: 220, h: 46 };
  const docs = { x: ox + 176, y: oy - 104, w: 112, h: 38 };
  const board = { x: ox + 312, y: oy - 106, w: 168, h: 44 };
  groups.push({ name: "主控", common: true, pi: t.projects.length, els: [{ seg: [spine.x, spine.y0, spine.x, bands[0].top - ROW / 2] }, { rect: [header.x, header.y, header.w, header.h] }, { rect: [docs.x, docs.y, docs.w, docs.h] }, { rect: [board.x, board.y, board.w, board.h] },
    // 只进场：把头、书架、公告板和脊连成一片，别在中间空出湖
    { seg: [spine.x, spine.y0, docs.x, docs.y + docs.h / 2] }, { seg: [docs.x + docs.w, docs.y + docs.h / 2, board.x, board.y + board.h / 2] }, { seg: [header.x + 20, header.y + header.h, spine.x, spine.y0] },
    { rect: [ox + 6 - headLobe, header.y + 10, headLobe, bands[0].top - ROW - header.y - 10], shape: true }] });
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const g of groups) for (const e of g.els) {
    const pts = e.seg ? [[e.seg[0], e.seg[1]], [e.seg[2], e.seg[3]]] : [[e.rect[0], e.rect[1]], [e.rect[0] + e.rect[2], e.rect[1] + e.rect[3]]];
    for (const [px, py] of pts) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  }
  const waits = t.projects.reduce((s, p) => s + p.lanes.reduce((a, l) => a + (l.wait?.length || 0), 0), 0);
  const running = t.projects.reduce((s, p) => s + p.lanes.filter((l) => l.running).length, 0);
  const headBottom = Math.max(docs.y + docs.h, board.y + board.h);
  for (const g of groups) { g.core = g.els.filter((e) => !e.shape); g.lanes = g.els.filter((e) => e.lane); }
  // 切法（用户 11-03 第四轮）：主控区和项目之间不切（cutStyles[0] = none），岛内水道不要了；
  // 项目之间东湾 / 西湾轮着来，但只在切得够深时才切：西湾要两边项目带往左伸出的地都够长，东湾要两条项目带都够长，
  // 不够就换另一边，两边都不够就不切、只留淡点线。单项目的专题因此没有任何缺口
  const cutStyles = ["none"];
  for (let k = 1; k < t.projects.length; k++) {
    const a = bands[k - 1], b = bands[k];
    const ok = { west: Math.min(lobes[k - 1], lobes[k]) >= 62, east: Math.min(a.end, b.end) - ox >= 380 };
    // 相邻两道湾不从同一边切（否则又是梳子）：上一道切了哪边，这一道只能切另一边，切不了就不切
    const prev = cutStyles[k - 1], pref = prev === "east" ? "west" : prev === "west" ? "east" : ["east", "west"][(off + k) % 2], other = pref === "east" ? "west" : "east";
    cutStyles.push(ok[pref] ? pref : prev === "none" && ok[other] ? other : "none");
  }
  return { t, ox, oy, groups, lanes, cards, bands, headBottom, cutStyles, spine, header, docs, board, bbox: { x0, y0, x1, y1 }, waits, running, nLanes: lanes.length };
}

// 专题在整张图上的位置：随机起点 + 互相推开 + 往中心收，算出来的，不手摆
// 试几十个随机起点，留下套进 16:10 画面后最紧凑的那个
function placeTopics(seed, margin = 175) {
  const all = [];
  for (let t = 0; t < 120; t++) {
    const p = placeOnce(1000 + t, margin), ar = 1.6;
    // 用户 11-03：别摆成规整的 2×2，按大小错落。左右上下边、中线对得越齐扣分越多
    let align = 0;
    for (let i = 0; i < p.rects.length; i++) for (let j = i + 1; j < p.rects.length; j++) {
      const a = p.rects[i], b = p.rects[j];
      for (const [u, v] of [[a.x0, b.x0], [a.x1, b.x1], [a.y0, b.y0], [a.y1, b.y1], [(a.x0 + a.x1) / 2, (b.x0 + b.x1) / 2], [(a.y0 + a.y1) / 2, (b.y0 + b.y1) / 2]]) align += Math.exp(-(((u - v) / 60) ** 2));
    }
    const score = Math.max(p.W, p.H * ar) * Math.max(p.H, p.W / ar) * (1 + 0.5 * align);
    all.push({ ...p, score });
  }
  // 候选摆法用同一批随机起点（不随种子变），去重后按种子挑一种：不同种子才会挑到不同的摆法
  all.sort((a, b) => a.score - b.score);
  // 同一种摆法（各专题的左右、上下次序一样）只留一个，再挑
  // 粗一点：每个专题的中心落在整体的哪个 3×3 格里，格子一样就算同一种摆法
  const sig = (p) => {
    const X0 = Math.min(...p.rects.map((r) => r.x0)), X1 = Math.max(...p.rects.map((r) => r.x1)), Y0 = Math.min(...p.rects.map((r) => r.y0)), Y1 = Math.max(...p.rects.map((r) => r.y1));
    return p.rects.map((r) => Math.min(2, Math.floor((((r.x0 + r.x1) / 2 - X0) / (X1 - X0)) * 3)) + "" + Math.min(2, Math.floor((((r.y0 + r.y1) / 2 - Y0) / (Y1 - Y0)) * 3))).join(",");
  };
  const grid = (p) => { const c = sig(p).split(","); return new Set(c.map((q) => q[0])).size <= 2 && new Set(c.map((q) => q[1])).size <= 2; };
  const seen = new Set(), good = all.filter((p) => p.score < all[0].score * 1.4 && !seen.has(sig(p)) && seen.add(sig(p)));
  const top = (good.some((p) => !grid(p)) ? good.filter((p) => !grid(p)) : good).slice(0, 6);
  const pick = rng(seed * 7919 + 11); pick(); const ix = Math.floor(pick() * top.length);
  if (process.env.SKDEBUG) console.log("place", seed, top.length, ix, top.map((p) => Math.round(p.score / 1e4)).join(","));
  return top[ix];
}
function placeOnce(seed, margin) {
  const r = rng(seed);
  const boxes = TOPICS.map((t, i) => { const b = layoutTopic(t, 0, 0, true, i).bbox; return { ...b, w: b.x1 - b.x0, h: b.y1 - b.y0 }; });
  const pos = boxes.map(() => [(r() - 0.5) * 900, (r() - 0.5) * 600]);
  for (let it = 0; it < 800; it++) {
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      const dx = pos[j][0] - pos[i][0], dy = pos[j][1] - pos[i][1];
      const ox = (boxes[i].w + boxes[j].w) / 2 + margin - Math.abs(dx), oy = (boxes[i].h + boxes[j].h) / 2 + margin - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox < oy * 1.25) { const s = Math.sign(dx || 1) * ox / 2; pos[i][0] -= s; pos[j][0] += s; }
        else { const s = Math.sign(dy || 1) * oy / 2; pos[i][1] -= s; pos[j][1] += s; }
      }
    }
    for (const p of pos) { p[0] *= 0.992; p[1] *= 0.985; }
  }
  const PAD = 150;
  let mx = 1e9, my = 1e9, Mx = -1e9, My = -1e9;
  const tl = pos.map((p, i) => [p[0] - boxes[i].w / 2, p[1] - boxes[i].h / 2]);
  tl.forEach((q, i) => { mx = Math.min(mx, q[0]); my = Math.min(my, q[1]); Mx = Math.max(Mx, q[0] + boxes[i].w); My = Math.max(My, q[1] + boxes[i].h); });
  const offs = tl.map((q, i) => [q[0] - mx + PAD - boxes[i].x0, q[1] - my + PAD - boxes[i].y0]);
  const rects = tl.map((q, i) => ({ x0: q[0], y0: q[1], x1: q[0] + boxes[i].w, y1: q[1] + boxes[i].h }));
  return { offs, rects, W: Mx - mx + 2 * PAD, H: My - my + 2 * PAD };
}

// ---------------- 距离场 → 区域场 ----------------
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
function dist(el, x, y) {
  if (el.seg) {
    const [ax, ay, bx, by] = el.seg, vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
    const t = L ? clamp(((x - ax) * vx + (y - ay) * vy) / L, 0, 1) : 0;
    return Math.hypot(x - ax - t * vx, y - ay - t * vy);
  }
  const [rx, ry, rw, rh] = el.rect, dx = Math.max(rx - x, 0, x - rx - rw), dy = Math.max(ry - y, 0, y - ry - rh);
  return Math.hypot(dx, dy);
}
const distGroup = (els, x, y, k) => { let d = 1e9; for (const el of els) d = smin(d, dist(el, x, y), k); return d; };

// 每个专题一张格子：e = 各组（项目 + 主控）场的最大值，>0 就在区域里；z[g] = 这一组比别的组高出多少（0 线是项目分界）
function buildGrid(T, ti, prm, cell, post) {
  const pad = prm.R + prm.A + 90;
  const x0 = T.bbox.x0 - pad, y0 = T.bbox.y0 - pad;
  const nx = Math.ceil((T.bbox.x1 - T.bbox.x0 + 2 * pad) / cell) + 1, ny = Math.ceil((T.bbox.y1 - T.bbox.y0 + 2 * pad) / cell) + 1;
  const ng = T.groups.length, N = nx * ny;
  const base = makeNoise(SEED * 31 + prm.seed), gn = T.groups.map((_, g) => makeNoise(SEED * 131 + ti * 17 + g + prm.seed));
  const wx = makeNoise(SEED * 41 + prm.seed), wy = makeNoise(SEED * 43 + prm.seed), W = prm.warp ?? 0, LW = prm.LW ?? 170;
  const e = new Float32Array(N), lab = new Uint8Array(N), eg = T.groups.map(() => new Float32Array(N)), ez = T.groups.map(() => new Float32Array(N)), lakeD = new Float32Array(N), keepA = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * cell, y = y0 + j * cell, k = j * nx + i;
    const b = prm.A * fbm(base, x / prm.L, y / prm.L, prm.oct, prm.gain ?? 0.5);
    // 扭一下取样点（domain warp），轮廓才会有海湾和半岛；但线路两侧 16 以内一定在区域里
    const qx = x + W * fbm(wx, x / LW, y / LW, 3), qy = y + W * fbm(wy, x / LW, y / LW, 3);
    let best = -1e9, bi = 0, second = -1e9, si = 0, keep = -1e9, zb = -1e9, zbi = 0, z2 = -1e9, zsi = 0;
    for (let g = 0; g < ng; g++) {
      const R = T.groups[g].common ? prm.R * 0.72 : prm.R, els = T.groups[g].els;
      let v = R - distGroup(els, qx, qy, prm.k) + b + prm.gA * fbm(gn[g], x / 70, y / 70, 2);
      if (W) {
        // 扭曲只改外轮廓：线路附近按没扭过的距离托底，项目分界不会被扭到别的项目的线路上
        const g0 = T.groups[g], d0 = distGroup(g0.core, x, y, prm.k), dl = g0.lanes.length ? distGroup(g0.lanes, x, y, prm.k) : 1e9;
        v = Math.max(v, prm.guard ? (prm.guardA ?? R + 8) - (prm.guardB ?? 1.6) * dl : 16 - d0);
        keep = Math.max(keep, 16 - d0);
      }
      eg[g][k] = v;
      if (W) {
        const zv = (ez[g][k] = R - distGroup(T.groups[g].core, x, y, prm.k) + (prm.zA ?? 8) * fbm(gn[g], x / 90, y / 90, 2));
        if (zv > zb) { z2 = zb; zsi = zbi; zb = zv; zbi = g; } else if (zv > z2) { z2 = zv; zsi = g; }
      }
      if (v > best) { second = best; si = bi; best = v; bi = g; } else if (v > second) { second = v; si = g; }
    }
    // 群岛：两个项目之间往下挖一道海峡（主控那一侧不挖），项目就成了岛上被海湾隔开的省
    keepA[k] = keep;
    if (prm.channel) {
      // 主控区和项目之间浅一点、窄一点（headCh），项目之间深。每道分隔按 cutStyles 轮着来（11-03 第三轮，不要一把梳子）：
      // east 从东边切进来；west 从西边切到主控脊为止（脊两侧 16 以内是陆地，等于留了地峡）；lake 是岛里的一条窄水道，两头都不通海
      const gb = T.groups[W ? zbi : bi], gs = T.groups[W ? zsi : si], head = !!(gb.common || gs.common), depth = head ? prm.headCh ?? 0 : prm.channel, w = head ? prm.headChW ?? prm.chW : prm.chW;
      const kb = head ? 0 : 1 + Math.min(gb.pi, gs.pi), sty = T.cutStyles?.[kb] ?? "east", near = Math.exp(-(((W ? zb - z2 : best - second) / (sty === "west" ? w * 1.6 : w * 1.9)) ** 2)), lx = x - T.ox;
      if (sty === "east" || sty === "west") {
        const ramp = sty === "east" ? clamp((lx - 150) / 120, 0, 1) : clamp((4 - lx) / 26, 0, 1);
        const t = ramp * near; best = Math.max(best * (1 - t) - depth * 0.5 * t, keep);
      }
    }
    let ev = post ? post(x, y, best) : best;
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) ev = Math.min(ev, -200);
    e[k] = ev; lab[k] = bi;
  }
  // 填湖：从格子边上能走到的 e<=0 才是海，围在区域里面的负值一律填平（区域里不留洞）
  const sea = new Uint8Array(N), st = [];
  for (let i = 0; i < nx; i++) st.push(i, (ny - 1) * nx + i);
  for (let j = 0; j < ny; j++) st.push(j * nx, j * nx + nx - 1);
  while (st.length) { const k = st.pop(); if (sea[k] || e[k] > 0) continue; sea[k] = 1; const i = k % nx, j = (k - i) / nx; if (i > 0) st.push(k - 1); if (i < nx - 1) st.push(k + 1); if (j > 0) st.push(k - nx); if (j < ny - 1) st.push(k + nx); }
  for (let k = 0; k < N; k++) if (!sea[k] && e[k] <= 0) e[k] = 0.5;
  // 岛里的水道在填湖之后再挖，才留得住；线路、牌子、脊两侧 16 以内照样托底
  for (let k = 0; k < N; k++) if (lakeD[k] > 0) e[k] = Math.max(e[k] - lakeD[k], Math.min(e[k], keepA[k]));
  const zs = [], z = [];
  for (let g = 0; g < ng; g++) {
    const a = new Float32Array(N), b = new Float32Array(N);
    for (let k = 0; k < N; k++) { let o = -1e9; const zf = W ? ez : eg; for (let h = 0; h < ng; h++) if (h !== g) o = Math.max(o, zf[h][k]); a[k] = zf[g][k] - o; b[k] = Math.min(a[k], e[k]); }
    zs.push(a); z.push(b);
  }
  return { nx, ny, x0, y0, c: cell, e, lab, eg, zs, z };
}
function sample(G, f, x, y) {
  const fx = (x - G.x0) / G.c, fy = (y - G.y0) / G.c;
  if (fx < 0 || fy < 0 || fx >= G.nx - 1 || fy >= G.ny - 1) return -1e9;
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, k = j * G.nx + i;
  return (f[k] * (1 - u) + f[k + 1] * u) * (1 - v) + (f[k + G.nx] * (1 - u) + f[k + G.nx + 1] * u) * v;
}
const labelAt = (G, x, y) => G.lab[Math.round((y - G.y0) / G.c) * G.nx + Math.round((x - G.x0) / G.c)];

// ---------------- marching squares ----------------
function iso(G, f, level) {
  const { nx, ny, x0, y0, c } = G, at = (i, j) => f[j * nx + i];
  const pts = new Map();
  const ept = (key, i0, j0, i1, j1) => { if (!pts.has(key)) { const a = at(i0, j0) - level, b = at(i1, j1) - level, t = a / (a - b); pts.set(key, [x0 + (i0 + (i1 - i0) * t) * c, y0 + (j0 + (j1 - j0) * t) * c]); } return key; };
  const segs = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = at(i, j) > level, b = at(i + 1, j) > level, cc = at(i + 1, j + 1) > level, d = at(i, j + 1) > level;
    const idx = a * 8 + b * 4 + cc * 2 + d;
    if (idx === 0 || idx === 15) continue;
    const T = () => ept((j * nx + i) * 2, i, j, i + 1, j), R = () => ept((j * nx + i + 1) * 2 + 1, i + 1, j, i + 1, j + 1), B = () => ept(((j + 1) * nx + i) * 2, i, j + 1, i + 1, j + 1), L = () => ept((j * nx + i) * 2 + 1, i, j, i, j + 1);
    const ctr = () => (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 > level;
    switch (idx) {
      case 1: case 14: segs.push([L(), B()]); break;
      case 2: case 13: segs.push([B(), R()]); break;
      case 3: case 12: segs.push([L(), R()]); break;
      case 4: case 11: segs.push([T(), R()]); break;
      case 6: case 9: segs.push([T(), B()]); break;
      case 7: case 8: segs.push([L(), T()]); break;
      case 5: if (ctr()) { segs.push([L(), T()], [B(), R()]); } else { segs.push([L(), B()], [T(), R()]); } break;
      case 10: if (ctr()) { segs.push([L(), B()], [T(), R()]); } else { segs.push([L(), T()], [B(), R()]); } break;
    }
  }
  const adj = new Map();
  segs.forEach((s, k) => { for (const e of s) { if (!adj.has(e)) adj.set(e, []); adj.get(e).push(k); } });
  const used = new Uint8Array(segs.length), lines = [];
  const extend = (ch) => { for (;;) { const last = ch[ch.length - 1], nb = adj.get(last).find((q) => !used[q]); if (nb === undefined) break; used[nb] = 1; const s = segs[nb]; ch.push(s[0] === last ? s[1] : s[0]); } };
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue; used[k] = 1;
    const ch = [segs[k][0], segs[k][1]]; extend(ch); ch.reverse(); extend(ch);
    const closed = ch.length > 2 && ch[0] === ch[ch.length - 1];
    if (closed) ch.pop();
    lines.push({ pts: ch.map((e) => pts.get(e)), closed });
  }
  return lines;
}
function chaikin(l, it = 2) {
  let p = l.pts;
  for (let n = 0; n < it; n++) {
    const q = []; const m = p.length;
    if (m < 3) break;
    for (let i = 0; i < (l.closed ? m : m - 1); i++) { const a = p[i], b = p[(i + 1) % m]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
    if (!l.closed) { q.unshift(p[0]); q.push(p[m - 1]); }
    p = q;
  }
  return { pts: p, closed: l.closed };
}
// 只留满足条件的那几段（项目分界只画在区域里面）
function clipLines(lines, pred) {
  const out = [];
  for (const l of lines) {
    const ok = l.pts.map(pred);
    if (ok.every(Boolean)) { out.push(l); continue; }
    let run = [];
    const n = l.pts.length, start = l.closed ? ok.indexOf(false) : 0;
    for (let s = 0; s < (l.closed ? n + 1 : n); s++) { const i = (start + s) % n; if (ok[i]) run.push(l.pts[i]); else { if (run.length > 1) out.push({ pts: run, closed: false }); run = []; } }
    if (run.length > 1) out.push({ pts: run, closed: false });
  }
  return out;
}
const area = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s / 2); };
function simplifyOcto(l) { // 地铁方向：去掉共线点，只留拐角
  const p = l.pts, n = p.length, q = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    if (!l.closed && (i === 0 || i === n - 1)) { q.push(b); continue; }
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) > 1e-3) q.push(b);
  }
  return { pts: q, closed: l.closed };
}

// ---------------- SVG 小工具 ----------------
const f1 = (n) => Math.round(n * 10) / 10;
const D = (l) => "M" + l.pts.map((p) => f1(p[0]) + " " + f1(p[1])).join("L") + (l.closed ? "Z" : "");
const DD = (lines) => lines.map(D).join("");
const ICE = (a) => `rgba(230,242,252,${a})`;
const GOLD = "#ffc482", GOLDA = (a) => `rgba(255,196,130,${a})`;
const TINTS = ["196,226,252", "182,236,232", "214,206,250", "236,226,206"];
const tint = (g, a, common) => common ? `rgba(230,240,248,${a})` : `rgba(${TINTS[g % TINTS.length]},${a})`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function makeViews(world, focus) {
  const fit = (x, y, w, h, W, H, lod) => {
    const ar = W / H;
    if (w / h > ar) { const nh = w / ar; y -= (nh - h) / 2; h = nh; } else { const nw = h * ar; x -= (nw - w) / 2; w = nw; }
    const s = W / w; return { x, y, w, h, W, H, s, lod, px: (n) => n / s };
  };
  const b = focus.bbox;
  return { far: fit(0, 0, world.W, world.H, 1600, 1000, "far"), mid: fit(b.x0 - 100, b.y0 - 70, b.x1 - b.x0 + 200, b.y1 - b.y0 + 150, 1600, 1000, "mid") };
}

function svgDoc(v, body) {
  const { x, y, w, h, px } = v;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f1(x)} ${f1(y)} ${f1(w)} ${f1(h)}" width="${v.W}" height="${v.H}" font-family="'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',sans-serif">
<defs>
<radialGradient id="bg0" cx=".5" cy="1" r="1.15"><stop offset="0" stop-color="#0f151b"/><stop offset=".55" stop-color="#18212a"/><stop offset="1" stop-color="#222d37"/></radialGradient>
<radialGradient id="bg1" cx=".5" cy=".03" r=".62"><stop offset="0" stop-color="#3a4957" stop-opacity=".75"/><stop offset="1" stop-color="#2a3642" stop-opacity="0"/></radialGradient>
<radialGradient id="bg2" cx=".5" cy=".55" r=".78"><stop offset=".62" stop-color="#080c10" stop-opacity="0"/><stop offset="1" stop-color="#080c10" stop-opacity=".5"/></radialGradient>
<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${f1(px(2.4))}"/></filter>
<filter id="glow2" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${f1(px(5))}"/></filter>
<filter id="dotglow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${f1(px(1.6))}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" fill="url(#bg0)"/>
<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" fill="url(#bg1)"/>
${body}
<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" fill="url(#bg2)" pointer-events="none"/>
</svg>`;
}

// ---------------- 线路（各方向共用；地铁方向换成粗线 + 站点刻度） ----------------
function drawLanes(T, v, metro) {
  const { px } = v, far = v.lod === "far";
  let glow = "", base = "", top = "", goldGlow = "", gold = "", text = "";
  const pt = (p) => `${f1(p[0])} ${f1(p[1])}`;
  const circle = (p, r, attrs) => `<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="${f1(r)}" ${attrs}/>`;
  const chevrons = (p, on, k = 1) => {
    let s = "";
    for (let i = 1; i <= 3; i++) {
      const x = p[0] + px((7 + 6 * i) * k), y = p[1], a = on ? [0.9, 0.58, 0.3][i - 1] : [0.42, 0.28, 0.16][i - 1];
      s += `<path d="M${f1(x - px(2.2 * k))} ${f1(y - px(3.2 * k))}L${f1(x + px(1 * k))} ${f1(y)}L${f1(x - px(2.2 * k))} ${f1(y + px(3.2 * k))}" stroke="${ICE(a)}" stroke-width="${f1(px(1.2 * k))}" fill="none"/>`;
    }
    return s;
  };
  const hubsDone = new Set();
  for (const L of T.lanes) {
    const tr = [...L.pre, ...L.nodes.map((n) => n.p)];
    const col = metro ? `rgb(${TINTS[L.pi % TINTS.length]})` : null;
    const wMain = metro ? (far ? 2 : 2.6) : far ? 1.1 : 1.4;
    const stroke = (a) => (metro ? `rgba(${TINTS[L.pi % TINTS.length]},${a})` : ICE(a));
    // 走过的
    glow += `<path d="M${tr.map(pt).join("L")}" stroke="${stroke(metro ? 0.35 : 0.55)}" stroke-width="${f1(px(metro ? 6 : 3.2))}" fill="none" stroke-linejoin="round"/>`;
    base += `<path d="M${tr.map(pt).join("L")}" stroke="${stroke(metro ? 0.95 : 0.85)}" stroke-width="${f1(px(wMain))}" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
    // 还没走的（到终点）
    if (L.done) base += `<path d="M${pt(L.front.p)}L${pt(L.end)}" stroke="${stroke(0.8)}" stroke-width="${f1(px(wMain))}" fill="none"/>`;
    else base += `<path d="M${pt(L.front.p)}L${pt(L.end)}" stroke="${stroke(0.3)}" stroke-width="${f1(px(metro ? 1.4 : 1))}" stroke-dasharray="${f1(px(3))} ${f1(px(4))}" fill="none"/>`;
    // 支线
    for (const s of L.subs) {
      const a = s.abandoned ? 0.28 : 0.62;
      base += `<path d="M${s.path.map(pt).join("L")}" stroke="${stroke(a)}" stroke-width="${f1(px(metro ? (far ? 1.4 : 1.8) : far ? 0.7 : 1))}" fill="none" stroke-linejoin="round"${s.abandoned ? ` stroke-dasharray="${f1(px(2))} ${f1(px(3))}"` : ""}/>`;
      if (!far) {
        top += circle(s.branch.p, px(metro ? 5 : 4.2), `fill="none" stroke="${ICE(0.6)}" stroke-width="${f1(px(1))}"`);
        if (s.merge) top += circle(s.merge.p, px(metro ? 5 : 4.2), `fill="none" stroke="${ICE(0.6)}" stroke-width="${f1(px(1))}"`);
        s.nodes.forEach((q, i) => {
          const last = i === s.nodes.length - 1;
          if (last && s.running) { glow += circle(q.p, px(5), `fill="${ICE(0.7)}"`); top += circle(q.p, px(3.2), `fill="${ICE(0.95)}"`) + chevrons(q.p, true, 0.8); }
          else if (metro) top += `<path d="M${pt(q.p)}l0 ${f1(-px(4))}" stroke="${stroke(a + 0.2)}" stroke-width="${f1(px(1.6))}"/>`;
          else top += circle(q.p, px(2), `fill="#1a242e" stroke="${ICE(a + 0.1)}" stroke-width="${f1(px(0.8))}"`);
        });
        if (s.abandoned) { const q = s.nodes[s.nodes.length - 1].p, d = px(3.5); top += `<path d="M${f1(q[0] + px(8) - d)} ${f1(q[1] - d)}l${f1(2 * d)} ${f1(2 * d)}m0 ${f1(-2 * d)}l${f1(-2 * d)} ${f1(2 * d)}" stroke="${ICE(0.45)}" stroke-width="${f1(px(1))}"/>`; }
      } else if (s.running) { const q = s.nodes[s.nodes.length - 1].p; glow += circle(q, px(4), `fill="${ICE(0.6)}"`); top += circle(q, px(1.6), `fill="${ICE(0.95)}"`); }
    }
    // 起点
    if (metro) {
      const hk = `${L.pi}`;
      if (!hubsDone.has(hk)) { hubsDone.add(hk); top += circle(L.pre[0], px(far ? 3 : 4.5), `fill="#1a242e" stroke="${ICE(0.95)}" stroke-width="${f1(px(far ? 1.4 : 2))}"`); }
    } else {
      const s0 = L.pre[0], h = px(far ? 4 : 6);
      top += `<path d="M${f1(s0[0])} ${f1(s0[1] - h)}l0 ${f1(2 * h)}" stroke="${ICE(0.9)}" stroke-width="${f1(px(far ? 1.2 : 1.6))}"/>`;
    }
    // 每一轮
    if (!far) {
      for (const n of L.nodes) {
        if (n === L.front || n.wait) continue;
        if (metro) top += `<path d="M${pt(n.p)}l0 ${f1(-px(5))}" stroke="${stroke(0.95)}" stroke-width="${f1(px(2))}"/>`;
        else top += circle(n.p, px(2.4), `fill="#1a242e" stroke="${ICE(0.82)}" stroke-width="${f1(px(0.9))}"`);
      }
      text += `<text x="${f1(metro ? L.nodes[1].p[0] - px(4) : L.pre[0][0])}" y="${f1(L.ry - px(metro ? 9 : 7))}" font-size="${f1(px(9.5))}" fill="${ICE(0.55)}" letter-spacing="${f1(px(0.6))}">${esc(L.name)}</text>`;
    }
    // 前锋
    const f = L.front.p;
    if (!L.front.wait) {
      glow += circle(f, px(far ? 4 : 7), `fill="${ICE(L.running ? 0.75 : 0.35)}"`);
      top += metro && !far ? circle(f, px(4.6), `fill="#1a242e" stroke="${ICE(1)}" stroke-width="${f1(px(2))}"`) : circle(f, px(far ? 2 : 4), `fill="${ICE(0.96)}"`);
    }
    if (!L.done && !far) top += chevrons(f, L.running);
    // 终点
    const e = L.end;
    if (L.done) { glow += circle(e, px(far ? 6 : 10), `fill="${ICE(0.6)}"`); top += circle(e, px(far ? 2.6 : 4.5), `fill="${ICE(1)}"`) + circle(e, px(far ? 4.5 : 7.5), `fill="none" stroke="${ICE(0.6)}" stroke-width="${f1(px(1))}"`); }
    else if (L.review) top += circle(e, px(far ? 3 : 5), `fill="none" stroke="${ICE(0.75)}" stroke-width="${f1(px(1.1))}"`) + `<path d="M${f1(e[0])} ${f1(e[1] - px(far ? 3 : 5))}a${f1(px(far ? 3 : 5))} ${f1(px(far ? 3 : 5))} 0 0 1 0 ${f1(px(far ? 6 : 10))}Z" fill="${ICE(0.75)}"/>`;
    else if (metro) top += `<path d="M${f1(e[0])} ${f1(e[1] - px(far ? 4 : 7))}l0 ${f1(px(far ? 8 : 14))}" stroke="${ICE(0.42)}" stroke-width="${f1(px(far ? 1.4 : 2.4))}"/>`;
    else top += circle(e, px(far ? 3 : 5), `fill="none" stroke="${ICE(0.38)}" stroke-width="${f1(px(1))}" stroke-dasharray="${f1(px(2))} ${f1(px(2))}"`);
    // 等你
    for (const n of L.nodes) if (n.wait) {
      goldGlow += circle(n.p, px(far ? 9 : 13), `fill="${GOLDA(0.55)}"`);
      gold += circle(n.p, px(far ? 3.2 : 3.6), `fill="${GOLD}"`) + circle(n.p, px(far ? 6 : 8), `fill="none" stroke="${GOLD}" stroke-width="${f1(px(1.3))}"`);
      if (!far) gold += `<path d="M${f1(n.p[0] + px(6))} ${f1(n.p[1] - px(6))}l${f1(px(8))} ${f1(-px(8))}h${f1(px(4))}" stroke="${GOLDA(0.8)}" stroke-width="${f1(px(0.9))}" fill="none"/><text x="${f1(n.p[0] + px(20))}" y="${f1(n.p[1] - px(11))}" font-size="${f1(px(10))}" fill="${GOLD}" letter-spacing="${f1(px(1.5))}">等你</text>`;
    }
  }
  return `<g filter="url(#glow)" opacity=".9">${glow}</g><g>${base}</g><g>${top}</g><g filter="url(#glow2)">${goldGlow}</g><g>${gold}</g><g>${text}</g>`;
}

// 头部、主控脊、项目状态牌、规范文档、公告板：简单的块和占位字
function drawFurniture(T, v) {
  const { px } = v, far = v.lod === "far";
  let s = "";
  const R = (x, y, w, h, a = 0.07, sa = 0.3) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(px(2))}" fill="rgba(175,200,220,${a})" stroke="${ICE(sa)}" stroke-width="${f1(px(0.8))}"/>`;
  const bar = (x, y, w, a = 0.2) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(px(2.6))}" fill="${ICE(a)}"/>`;
  const txt = (x, y, size, fill, str, extra = "") => `<text x="${f1(x)}" y="${f1(y)}" font-size="${f1(size)}" fill="${fill}" ${extra}>${str}</text>`;
  // 头部
  const h = T.header, ns = T.t.projects.length;
  const tSize = far ? px(17) : px(21), sSize = far ? px(10) : px(10.5);
  s += txt(h.x, h.y + h.h * 0.5, tSize, "#fff", esc(T.t.name), `font-weight="300" letter-spacing="${f1(px(far ? 2.5 : 3))}"`);
  const sum = `${ns} 项目 · ${T.nLanes} 任务 · ${T.running} 在跑`;
  s += `<text x="${f1(h.x)}" y="${f1(h.y + h.h * 0.5 + (far ? px(17) : px(19)))}" font-size="${f1(sSize)}" fill="${ICE(0.6)}" letter-spacing="${f1(px(1))}">${sum}${T.waits ? `<tspan fill="${GOLD}"> · ${T.waits} 等你</tspan>` : ""}</text>`;
  // 主控脊
  const sp = T.spine;
  s += `<path d="M${f1(sp.x)} ${f1(sp.y0)}L${f1(sp.x)} ${f1(sp.y1)}" stroke="${ICE(0.5)}" stroke-width="${f1(px(far ? 0.9 : 1.1))}"/>`;
  const nd = 4;
  for (let i = 0; i < nd; i++) { const yy = sp.y0 + ((sp.y1 - sp.y0) * (i + 0.5)) / nd, d = px(far ? 2.5 : 3.6); s += `<path d="M${f1(sp.x)} ${f1(yy - d)}l${f1(d)} ${f1(d)}l${f1(-d)} ${f1(d)}l${f1(-d)} ${f1(-d)}Z" fill="#1a242e" stroke="${ICE(0.8)}" stroke-width="${f1(px(0.9))}"/>`; }
  if (!far) s += txt(sp.x + px(6), sp.y0 + px(3), px(9), ICE(0.55), "主控", `letter-spacing="${f1(px(2))}"`);
  // 项目状态牌
  for (const c of T.cards) {
    if (!far) s += `<path d="M${f1(T.spine.x)} ${f1(c.y + c.h / 2)}L${f1(c.x)} ${f1(c.y + c.h / 2)}" stroke="${ICE(0.25)}" stroke-width="${f1(px(0.8))}"/>`;
    s += R(c.x, c.y, c.w, c.h, far ? 0.05 : 0.08, far ? 0.22 : 0.32);
    if (c.waits) s += `<rect x="${f1(c.x)}" y="${f1(c.y)}" width="${f1(px(far ? 2 : 2.5))}" height="${f1(c.h)}" fill="${GOLD}"/>`;
    if (!far) {
      s += txt(c.x + px(7), c.y + px(13), px(9.5), ICE(0.85), esc(c.pr.name), `letter-spacing="${f1(px(0.4))}"`);
      s += bar(c.x + px(7), c.y + c.h - px(14), c.w * 0.55) + bar(c.x + px(7), c.y + c.h - px(8), c.w * 0.32, 0.13);
    }
  }
  // 规范文档（书架）和公告板
  const dk = T.docs, bd = T.board;
  if (far) { s += R(dk.x, dk.y, dk.w, dk.h, 0.03, 0.14) + R(bd.x, bd.y, bd.w, bd.h, 0.03, 0.14); return s; }
  s += txt(dk.x, dk.y - px(4), px(8.5), ICE(0.5), "规范 · 文档", `letter-spacing="${f1(px(1.5))}"`);
  const hs = [0.9, 0.75, 1, 0.82, 0.68, 0.94];
  hs.forEach((k, i) => { const w = dk.w / 8.2, x = dk.x + i * (w + dk.w / 30), hh = dk.h * k; s += R(x, dk.y + dk.h - hh, w, hh, 0.09, 0.34); });
  s += txt(bd.x, bd.y - px(4), px(8.5), ICE(0.5), "公告板", `letter-spacing="${f1(px(1.5))}"`);
  s += R(bd.x, bd.y, bd.w, bd.h, 0.06, 0.3) + bar(bd.x + px(7), bd.y + px(8), bd.w * 0.6) + bar(bd.x + px(7), bd.y + px(16), bd.w * 0.45, 0.15) + bar(bd.x + px(7), bd.y + px(24), bd.w * 0.52, 0.12);
  return s;
}

// ---------------- 各方向的「地面」 ----------------
function worldGrid(world, cell, fn) {
  const nx = Math.ceil(world.W / cell) + 1, ny = Math.ceil(world.H / cell) + 1, v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = fn(i * cell, j * cell);
  return { nx, ny, x0: 0, y0: 0, c: cell, v };
}

const DIRS = {
  // 1 等高线：区域是一圈圈等高线围起来的地形，项目各是一个「盆地」，在鞍部连起来
  contour: {
    prm: { R: 50, A: 20, L: 160, oct: 4, gA: 7, k: 30, seed: 1, warp: 46, LW: 190 }, cell: 4,
    ground(ctx) {
      const nb = makeNoise(SEED * 7 + 3);
      const bg = worldGrid(ctx.world, 12, (x, y) => fbm(nb, x / 360, y / 360, 3));
      const bgLines = []; for (let l = -0.8; l <= 0.81; l += 0.1) bgLines.push(...iso(bg, bg.v, l).map((q) => chaikin(q)));
      const topics = ctx.topics.map(({ T, G }) => ({
        T, G,
        coast: iso(G, G.e, 0).map((q) => chaikin(q)),
        rings: [11, 22, 33].map((l) => iso(G, G.e, l).map((q) => chaikin(q))),
        outer: [-13, -28].map((l) => iso(G, G.e, l).map((q) => chaikin(q))),
        zones: T.groups.map((g, gi) => iso(G, G.z[gi], 0).map((q) => chaikin(q))),
        borders: T.groups.flatMap((g, gi) => clipLines(iso(G, G.zs[gi], 0), (p) => sample(G, G.e, p[0], p[1]) > 4).map((q) => chaikin(q))),
      }));
      return (v) => {
        const { px } = v;
        let s = `<mask id="out" maskUnits="userSpaceOnUse" x="${f1(v.x)}" y="${f1(v.y)}" width="${f1(v.w)}" height="${f1(v.h)}"><rect x="${f1(v.x)}" y="${f1(v.y)}" width="${f1(v.w)}" height="${f1(v.h)}" fill="#fff"/>${topics.map((t) => `<path d="${DD(t.outer[0])}" fill="#000" fill-rule="evenodd"/>`).join("")}</mask>`;
        s += `<g mask="url(#out)"><path d="${DD(bgLines)}" stroke="${ICE(0.05)}" stroke-width="${f1(px(0.8))}" fill="none"/></g>`;
        for (const t of topics) {
          t.zones.forEach((z, gi) => { s += `<path d="${DD(z)}" fill="${tint(gi, gi % 2 ? 0.035 : 0.06, t.T.groups[gi].common)}" fill-rule="evenodd"/>`; });
          t.outer.forEach((o, i) => { s += `<path d="${DD(o)}" stroke="${ICE([0.09, 0.05][i])}" stroke-width="${f1(px(0.8))}" fill="none"/>`; });
          t.rings.forEach((o, i) => { s += `<path d="${DD(o)}" stroke="${ICE([0.26, 0.19, 0.13][i])}" stroke-width="${f1(px(0.85))}" fill="none"/>`; });
          s += `<path d="${DD(t.borders)}" stroke="${ICE(0.32)}" stroke-width="${f1(px(0.9))}" stroke-dasharray="${f1(px(4))} ${f1(px(3))}" fill="none"/>`;
          s += `<path d="${DD(t.coast)}" stroke="${ICE(0.5)}" stroke-width="${f1(px(3))}" fill="none" filter="url(#glow)"/><path d="${DD(t.coast)}" stroke="${ICE(0.72)}" stroke-width="${f1(px(1.2))}" fill="none"/>`;
        }
        return s;
      };
    },
  },

  // 2 Voronoi 低多边形：整块地面切成大小渐变的多边形格子，一个专题是一簇格子，项目是子簇
  voronoi: {
    prm: { R: 48, A: 18, L: 130, oct: 3, gA: 6, k: 30, seed: 2, warp: 44, LW: 180, guard: true }, cell: 6,
    ground(ctx) {
      const r = rng(SEED * 3 + 11), nb = makeNoise(SEED * 5 + 1);
      const eAt = (x, y) => { let best = -1e9, ti = -1; ctx.topics.forEach(({ G }, i) => { const e = sample(G, G.e, x, y); if (e > best) { best = e; ti = i; } }); return [best, ti]; };
      const rad = (x, y) => { const e = eAt(x, y)[0]; return e > 0 ? 24 - 6 * clamp(e / 40, 0, 1) : 22 + 20 * clamp(-e / 90, 0, 1); };
      const sites = poissonVar(0, 0, ctx.world.W, ctx.world.H, rad, r);
      const cells = voronoiCells(sites, -20, -20, ctx.world.W + 20, ctx.world.H + 20, 46);
      const info = sites.map(([x, y]) => { const [e, ti] = eAt(x, y); if (e <= 0) return { ti: -1, e }; const G = ctx.topics[ti].G; return { ti, g: labelAt(G, x, y), e }; });
      const fills = [], outer = [], inner = [], bgEdges = [];
      cells.forEach((poly, i) => {
        const inf = info[i], [x, y] = sites[i];
        const d = "M" + poly.map((p) => f1(p.x) + " " + f1(p.y)).join("L") + "Z";
        if (inf.ti < 0) { bgEdges.push({ d, x, y }); return; }
        const T = ctx.topics[inf.ti].T, shade = 0.035 + 0.075 * clamp(0.5 + 0.6 * fbm(nb, x / 90, y / 90, 3), 0, 1) + 0.03 * clamp(inf.e / 45, 0, 1);
        fills.push({ d, x, y, fill: tint(inf.g, shade.toFixed(3), T.groups[inf.g].common) });
        poly.forEach((p, k) => {
          const q = poly[(k + 1) % poly.length], n = p.n, seg = { d: `M${f1(p.x)} ${f1(p.y)}L${f1(q.x)} ${f1(q.y)}`, x, y };
          if (n < 0 || info[n].ti !== inf.ti) outer.push(seg);
          else if (info[n].g !== inf.g && i < n) inner.push(seg);
        });
      });
      return (v) => {
        const { px } = v, inV = (o) => o.x > v.x - 60 && o.x < v.x + v.w + 60 && o.y > v.y - 60 && o.y < v.y + v.h + 60;
        let s = `<path d="${bgEdges.filter(inV).map((o) => o.d).join("")}" fill="none" stroke="${ICE(0.045)}" stroke-width="${f1(px(0.7))}"/>`;
        s += `<g stroke="${ICE(0.1)}" stroke-width="${f1(px(0.6))}">${fills.filter(inV).map((o) => `<path d="${o.d}" fill="${o.fill}"/>`).join("")}</g>`;
        const idd = inner.filter(inV).map((o) => o.d).join("");
        s += `<path d="${idd}" stroke="${ICE(0.35)}" stroke-width="${f1(px(2.4))}" fill="none" filter="url(#glow)"/><path d="${idd}" stroke="${ICE(0.58)}" stroke-width="${f1(px(1))}" fill="none" stroke-linecap="round" stroke-dasharray="${f1(px(4))} ${f1(px(2.5))}"/>`;
        const od = outer.filter(inV).map((o) => o.d).join("");
        s += `<path d="${od}" stroke="${ICE(0.45)}" stroke-width="${f1(px(3))}" fill="none" filter="url(#glow)"/><path d="${od}" stroke="${ICE(0.75)}" stroke-width="${f1(px(1.2))}" fill="none" stroke-linecap="round"/>`;
        return s;
      };
    },
  },

  // 6 地形岛（用户 11-03 定的方向之一）：等高线的岛型和内圈 + 群岛的海湾分割；岛外干干净净，不要小岛和浅滩，也不铺全图等高线。
  // 项目之间是从东边切进来的深海湾；主控区（头、规范、公告板）和项目之间是一道浅、窄一点的海湾
  terrain: {
    prm: { R: 50, A: 20, L: 160, oct: 4, gA: 3, k: 30, seed: 6, warp: 46, LW: 190, guard: true, guardA: 40, guardB: 1.5, channel: 50, chW: 26, headCh: 0 }, cell: 4,
    ground(ctx) {
      const topics = ctx.topics.map(({ T, G }) => ({
        T, G,
        coast: iso(G, G.e, 0).filter((q) => !q.closed || area(q.pts) > 3000).map((q) => chaikin(q)),
        zones: T.groups.map((g, gi) => iso(G, G.z[gi], 0).filter((q) => !q.closed || area(q.pts) > 3000).map((q) => chaikin(q))),
        borders: T.groups.flatMap((g, gi) => clipLines(iso(G, G.zs[gi], 0), (p) => sample(G, G.e, p[0], p[1]) > 4).map((q) => chaikin(q))),
      }));
      return (v) => {
        const { px } = v;
        let s = "";
        topics.forEach((t, ti) => {
          const cd = DD(t.coast);
          s += `<path d="${cd}" fill="${ICE(0.035)}" fill-rule="evenodd"/>`;
          t.zones.forEach((z, gi) => { s += `<path d="${DD(z)}" fill="${tint(gi, t.T.groups[gi].common ? 0.02 : gi % 2 ? 0.035 : 0.06, t.T.groups[gi].common)}" fill-rule="evenodd"/>`; });
          s += `<clipPath id="tc${ti}"><path d="${cd}" clip-rule="evenodd"/></clipPath><g clip-path="url(#tc${ti})"><path d="${cd}" stroke="${ICE(0.065)}" stroke-width="${f1(px(22))}" fill="none" filter="url(#glow2)"/><path d="${cd}" stroke="${ICE(0.035)}" stroke-width="${f1(px(50))}" fill="none" filter="url(#glow2)"/></g>`;
          s += `<path d="${DD(t.borders)}" stroke="${ICE(0.26)}" stroke-width="${f1(px(0.8))}" stroke-dasharray="${f1(px(2))} ${f1(px(3))}" fill="none"/>`;
          s += `<path d="${cd}" stroke="${ICE(0.5)}" stroke-width="${f1(px(3))}" fill="none" filter="url(#glow)"/><path d="${cd}" stroke="${ICE(0.76)}" stroke-width="${f1(px(1.15))}" fill="none"/>`;
        });
        return s;
      };
    },
  },

  // 3 地铁线路图：线路 45°/90° 转折，从项目的始发站扇出；专题是八方向折线围成的「票价分区」
  metro: {
    metro: true, prm: { R: 44, A: 20, L: 190, oct: 3, gA: 8, k: 26, seed: 3, warp: 50, LW: 210, guard: true, guardA: 40, guardB: 1.5 }, cell: 6,
    ground(ctx) {
      const C = 22;
      const topics = ctx.topics.map(({ T, G }) => {
        const nx = Math.ceil((G.nx * G.c) / C) + 1, ny = Math.ceil((G.ny * G.c) / C) + 1, mk = (fn) => { const v = new Float32Array(nx * ny); for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = G.x0 + i * C, y = G.y0 + j * C; v[j * nx + i] = i && j && i < nx - 1 && j < ny - 1 && fn(x, y) ? 1 : 0; } return v; };
        const M = { nx, ny, x0: G.x0, y0: G.y0, c: C };
        const zone = iso(M, mk((x, y) => sample(G, G.e, x, y) > 0), 0.5).map(simplifyOcto).filter((l) => area(l.pts) > 900);
        return { T, zone, ...headedBands(T, G) };
      });
      return (v) => {
        const { px } = v;
        let s = "";
        // 浅浅的点阵底，地铁图那种干净的版面
        const st = 44; let dots = "";
        for (let y = Math.floor(v.y / st) * st; y < v.y + v.h; y += st) for (let x = Math.floor(v.x / st) * st; x < v.x + v.w; x += st) dots += `M${x} ${y}h0.01`;
        s += `<path d="${dots}" stroke="${ICE(0.12)}" stroke-width="${f1(px(1.6))}" stroke-linecap="round"/>`;
        topics.forEach((t, ti) => {
          const np = t.T.t.projects.length;
          s += `<clipPath id="mz${ti}"><path d="${DD(t.zone)}"/></clipPath><g clip-path="url(#mz${ti})">`;
          t.polys.forEach((p, k) => { const gi = k === 0 ? np : k - 1; s += `<path d="${D(p)}" fill="${tint(gi, k === 0 ? 0.045 : 0.075, k === 0)}"/>`; });
          s += `<path d="${DD(t.cuts)}" fill="none" stroke="${ICE(0.34)}" stroke-width="${f1(px(0.9))}" stroke-dasharray="${f1(px(5))} ${f1(px(4))}" stroke-linejoin="round"/></g>`;
          s += `<path d="${DD(t.zone)}" fill="none" stroke="${ICE(0.07)}" stroke-width="${f1(px(9))}" stroke-linejoin="round"/>`;
          s += `<path d="${DD(t.zone)}" fill="none" stroke="${ICE(0.66)}" stroke-width="${f1(px(1.3))}" stroke-linejoin="round"/>`;
        });
        return s;
      };
    },
  },

  // 4 群岛：每个专题一座分形海岸线的岛，外圈是一层层浅滩，项目是岛上虚线分开的省，周围零星小岛
  isles: {
    prm: { R: 48, A: 26, L: 105, oct: 6, gain: 0.55, gA: 6, k: 30, seed: 4, warp: 40, LW: 170, channel: 50, chW: 26, guard: true }, cell: 3.5,
    post: () => { const n2 = makeNoise(SEED * 13 + 5); return (x, y, e) => (e > -6 ? e : Math.max(e, 26 * (fbm(n2, x / 34, y / 34, 4) - 0.42) - 0.75 * Math.abs(e + 34))); },
    ground(ctx) {
      const topics = ctx.topics.map(({ T, G }) => ({
        T, G,
        coast: iso(G, G.e, 0).map((q) => chaikin(q, 1)),
        shoals: [-9, -20, -34].map((l) => iso(G, G.e, l).map((q) => chaikin(q))),
        zones: T.groups.map((g, gi) => iso(G, G.z[gi], 0).map((q) => chaikin(q, 1))),
        borders: T.groups.flatMap((g, gi) => clipLines(iso(G, G.zs[gi], 0), (p) => sample(G, G.e, p[0], p[1]) > 6).map((q) => chaikin(q))),
      }));
      return (v) => {
        const { px } = v;
        // 海面：横向的细扫描线，岛上挖掉
        const step = px(7); let sea = "";
        for (let y = v.y; y < v.y + v.h; y += step) sea += `M${f1(v.x)} ${f1(y)}h${f1(v.w)}`;
        let s = `<mask id="sea" maskUnits="userSpaceOnUse" x="${f1(v.x)}" y="${f1(v.y)}" width="${f1(v.w)}" height="${f1(v.h)}"><rect x="${f1(v.x)}" y="${f1(v.y)}" width="${f1(v.w)}" height="${f1(v.h)}" fill="#fff"/>${topics.map((t) => `<path d="${DD(t.coast)}" fill="#000" fill-rule="evenodd"/>`).join("")}</mask>`;
        s += `<g mask="url(#sea)"><path d="${sea}" stroke="${ICE(0.035)}" stroke-width="${f1(px(1))}"/></g>`;
        for (const t of topics) {
          t.shoals.forEach((o, i) => { s += `<path d="${DD(o)}" stroke="${ICE([0.2, 0.12, 0.07][i])}" stroke-width="${f1(px(0.8))}" stroke-dasharray="${f1(px([3, 2, 1.5][i]))} ${f1(px([3, 4, 5][i]))}" fill="none"/>`; });
          s += `<path d="${DD(t.coast)}" fill="${ICE(0.035)}" fill-rule="evenodd"/>`;
          t.zones.forEach((z, gi) => { s += `<path d="${DD(z)}" fill="${tint(gi, gi % 2 ? 0.03 : 0.055, t.T.groups[gi].common)}" fill-rule="evenodd"/>`; });
          s += `<path d="${DD(t.borders)}" stroke="${ICE(0.42)}" stroke-width="${f1(px(0.9))}" stroke-dasharray="${f1(px(5))} ${f1(px(3))} ${f1(px(1))} ${f1(px(3))}" fill="none"/>`;
          s += `<path d="${DD(t.coast)}" stroke="${ICE(0.5)}" stroke-width="${f1(px(3))}" fill="none" filter="url(#glow)"/><path d="${DD(t.coast)}" stroke="${ICE(0.8)}" stroke-width="${f1(px(1))}" fill="none" stroke-linejoin="round"/>`;
        }
        return s;
      };
    },
  },

  // 5 点阵：地面是一张六边形点阵，区域里的点按「离线路多近」变大变亮，边缘自然散开；项目之间留一条空的街
  stipple: {
    prm: { R: 50, A: 20, L: 140, oct: 4, gA: 8, k: 30, seed: 5, warp: 44, LW: 180, guard: true }, cell: 5,
    ground(ctx) {
      const SP = 7.5, H = SP * 0.866, dots = [];
      const nb = makeNoise(SEED * 17 + 2);
      for (let j = 0, y = 0; y < ctx.world.H; j++, y += H) for (let i = 0, x = (j % 2) * SP / 2; x < ctx.world.W; i++, x += SP) {
        let best = -1e9, ti = -1;
        ctx.topics.forEach(({ G }, i) => { const e = sample(G, G.e, x, y); if (e > best) { best = e; ti = i; } });
        if (best > 0) {
          const { G, T } = ctx.topics[ti], g = labelAt(G, x, y), zm = sample(G, G.zs[g], x, y);
          // 半调网点：边缘一圈最密最亮，往里淡下去，内容才看得清；项目之间的点缩小，留出一条「街」
          const rim = Math.max(Math.exp(-(((best - 4) / 9) ** 2)), 0.62 * Math.exp(-(((zm * 1.4 - 2) / 5) ** 2)));
          const r = 0.55 + 1.25 * rim, a = 0.17 + 0.52 * rim;
          const c = T.groups[g].common ? [230, 240, 248] : TINTS[g % TINTS.length].split(",").map((v) => Math.round(+v * 0.45 + 238 * 0.55));
          dots.push({ x, y, r, a, col: c.join(",") });
        } else if (best > -40 || (j % 2 === 0 && i % 2 === 0)) {
          const n = 0.5 + 0.5 * fbm(nb, x / 200, y / 200, 2), near = best > -40 ? clamp(1 + best / 40, 0, 1) : 0;
          dots.push({ x, y, r: 0.42 + 0.25 * near, a: 0.05 + 0.05 * n + 0.08 * near, col: "230,242,252" });
        }
      }
      return (v) => {
        const buckets = new Map();
        for (const d of dots) {
          if (d.x < v.x - 10 || d.x > v.x + v.w + 10 || d.y < v.y - 10 || d.y > v.y + v.h + 10) continue;
          const r = Math.round(d.r * 5) / 5, a = Math.round(d.a * 20) / 20, key = `${r}|${a}|${d.col}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(`M${f1(d.x)} ${f1(d.y)}h0.01`);
        }
        let land = "", bg = "";
        for (const [key, arr] of buckets) { const [r, a, col] = key.split("|"); const p = `<path d="${arr.join("")}" stroke="rgba(${col},${a})" stroke-width="${f1(2 * r)}" stroke-linecap="round"/>`; if (+r > 0.8 && +a > 0.3) land += p; else bg += p; }
        return `<g>${bg}</g><g filter="url(#dotglow)">${land}</g>`;
      };
    },
  },
};

// ---------------- 地铁的分界：主控区 | 项目 1 | 项目 2 …，每条分界左段取在状态牌之间、右段取在线路之间，
// 中间（牌子和线路之间）用一段 45° 斜线接起来，所以是横平竖直加切角的折线，不随噪声乱走
function headedBands(T, G) {
  const xL = G.x0, xR = G.x0 + G.nx * G.c, yT = G.y0, yB = G.y0 + G.ny * G.c;
  const cut = (l, r, xj) => { const h = Math.abs(r - l) / 2; return { pts: [[xL, l], [xj - h, l], [xj + h, r], [xR, r]], closed: false }; };
  const cs = T.cards, bs = T.bands, cuts = [cut((T.spine.y0 + 14 + cs[0].y) / 2, (T.headBottom + bs[0].top - 12) / 2, T.ox + 140 + bs[0].shift)];
  for (let i = 0; i + 1 < bs.length; i++) cuts.push(cut((cs[i].y + cs[i].h + cs[i + 1].y) / 2, (bs[i].bottom + bs[i + 1].top - 12) / 2, T.ox + 140 + (bs[i].shift + bs[i + 1].shift) / 2));
  const polys = [];
  for (let k = 0; k <= cuts.length; k++) {
    const top = k === 0 ? [[xL, yT], [xR, yT]] : cuts[k - 1].pts, bot = k === cuts.length ? [[xL, yB], [xR, yB]] : cuts[k].pts;
    polys.push({ pts: [...top, ...bot.slice().reverse()], closed: true });
  }
  return { cuts, polys };
}

// ---------------- Voronoi 的辅助：变半径泊松采样 + 半平面裁剪出单元（带每条边的邻居） ----------------
function poissonVar(x0, y0, w, h, rad, rand) {
  const rmin = 14, cs = rmin / Math.SQRT2, gw = Math.ceil(w / cs) + 1, gh = Math.ceil(h / cs) + 1, grid = Array.from({ length: gw * gh }, () => []);
  const pts = [], radii = [], active = [];
  const add = (x, y) => { const i = pts.length; pts.push([x, y]); radii.push(rad(x, y)); active.push(i); grid[Math.floor((y - y0) / cs) * gw + Math.floor((x - x0) / cs)].push(i); };
  const ok = (x, y, r) => {
    if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
    const R = Math.ceil(46 / cs), gx = Math.floor((x - x0) / cs), gy = Math.floor((y - y0) / cs);
    for (let j = Math.max(0, gy - R); j <= Math.min(gh - 1, gy + R); j++) for (let i = Math.max(0, gx - R); i <= Math.min(gw - 1, gx + R); i++) for (const q of grid[j * gw + i]) { const m = (r + radii[q]) / 2, dx = pts[q][0] - x, dy = pts[q][1] - y; if (dx * dx + dy * dy < m * m) return false; }
    return true;
  };
  add(x0 + w / 2, y0 + h / 2);
  while (active.length) {
    const ai = Math.floor(rand() * active.length), i = active[ai], [px, py] = pts[i], r = radii[i];
    let placed = false;
    for (let t = 0; t < 24; t++) { const a = rand() * Math.PI * 2, d = r * (1 + rand()), x = px + Math.cos(a) * d, y = py + Math.sin(a) * d; const rr = rad(x, y); if (ok(x, y, rr)) { add(x, y); placed = true; break; } }
    if (!placed) active.splice(ai, 1);
  }
  return pts;
}
function voronoiCells(sites, bx0, by0, bx1, by1, maxR) {
  const cs = maxR, gw = Math.ceil((bx1 - bx0) / cs) + 1, gh = Math.ceil((by1 - by0) / cs) + 1, grid = Array.from({ length: gw * gh }, () => []);
  sites.forEach(([x, y], i) => grid[Math.floor((y - by0) / cs) * gw + Math.floor((x - bx0) / cs)].push(i));
  return sites.map(([sx, sy], i) => {
    let poly = [{ x: bx0, y: by0, n: -1 }, { x: bx1, y: by0, n: -1 }, { x: bx1, y: by1, n: -1 }, { x: bx0, y: by1, n: -1 }];
    const gx = Math.floor((sx - bx0) / cs), gy = Math.floor((sy - by0) / cs), cand = [];
    for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2); j++) for (let k = Math.max(0, gx - 2); k <= Math.min(gw - 1, gx + 2); k++) for (const q of grid[j * gw + k]) if (q !== i) cand.push([q, (sites[q][0] - sx) ** 2 + (sites[q][1] - sy) ** 2]);
    cand.sort((a, b) => a[1] - b[1]);
    for (const [k, d2] of cand) {
      let far = 0; for (const p of poly) far = Math.max(far, (p.x - sx) ** 2 + (p.y - sy) ** 2);
      if (d2 / 4 > far) break;
      const mx = (sx + sites[k][0]) / 2, my = (sy + sites[k][1]) / 2, nx = sites[k][0] - sx, ny = sites[k][1] - sy, side = (p) => (p.x - mx) * nx + (p.y - my) * ny;
      const out = [];
      for (let a = 0; a < poly.length; a++) {
        const P = poly[a], Q = poly[(a + 1) % poly.length], sp = side(P), sq = side(Q);
        const I = () => { const t = sp / (sp - sq); return { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t }; };
        if (sp <= 0) { out.push(P); if (sq > 0) out.push({ ...I(), n: k }); }
        else if (sq <= 0) out.push({ ...I(), n: P.n });
      }
      poly = out;
    }
    return poly;
  });
}

// ---------------- 生成 ----------------
for (const seed of SEEDS) {
SEED = seed;
const place = placeTopics(SEED);
const world = { W: place.W, H: place.H };
for (const [name, dir] of Object.entries(DIRS)) {
  if (!(ONLY.length ? ONLY : ["terrain", "metro"]).includes(name)) continue;
  const t0 = Date.now();
  const Ts = TOPICS.map((t, i) => layoutTopic(t, place.offs[i][0], place.offs[i][1], !!dir.metro, i));
  const post = dir.post ? dir.post() : null;
  const topics = Ts.map((T, i) => ({ T, G: buildGrid(T, i, dir.prm, dir.cell, post) }));
  const ctx = { world, topics };
  const ground = dir.ground(ctx);
  const views = makeViews(world, Ts[1]);
  for (const [vn, v] of Object.entries(views)) {
    if (vn === "mid" && seed !== SEEDS[0]) continue;
    const body = ground(v) + Ts.map((T) => drawFurniture(T, v) + drawLanes(T, v, !!dir.metro)).join("");
    const file = join(DIR, `${name}-${vn}-${seed}.svg`);
    const svg = svgDoc(v, body);
    writeFileSync(file, svg, "utf8");
    console.log(`${name}-${vn}-${seed}.svg  ${(svg.length / 1024).toFixed(0)} KB`);
  }
  console.log(`  ${name}: ${Date.now() - t0} ms`);
}
}
