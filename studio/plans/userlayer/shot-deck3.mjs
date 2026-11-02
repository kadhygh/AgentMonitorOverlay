// 验证 v-deck3.html（四套美术风格）：一律用真实的鼠标事件（page.mouse / locator.click），页面里的函数只用来算坐标、读状态。
// 用法（在 studio/ 下）：node plans/userlayer/shot-deck3.mjs [--only main,small,perf] [--styles oblivion,haze]
//   main：每套风格的交互和截图（studio/screenshots/userlayer/deck3-<风格>-far|mid|near|popup.png），第一套之后都用顶部的切换条换风格
//   small：1280×800 每套风格的全局和弹窗
//   perf：v-deck.html、v-deck2.html、v-deck3.html（四套风格，以及关掉模糊和叠加层的 #nofx）用同一套方法测 #stress 远、中、近三档的拖动帧率
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "../../screenshots/userlayer");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const only = arg("--only", "main,small,perf").split(",");
const STYLES = arg("--styles", "oblivion,nostromo,abyss,haze").split(",");
const fileUrl = (f) => pathToFileURL(join(dir, f)).href;
const browser = await chromium.launch({ channel: "msedge", args: ["--ignore-gpu-blocklist"] });
let fails = 0;
const check = (ok, what, extra = "") => { console.log((ok ? "  ✓ " : "  ✗ ") + what + (extra ? "  " + extra : "")); if (!ok) fails++; };

async function open(file, w, h, hash = "") {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(fileUrl(file) + hash);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(2600);
  return { page, errors };
}
const settle = async (page, extra = 300) => { await page.waitForTimeout(120); for (let i = 0; i < 120; i++) { if (!(await page.evaluate(() => window.__map.busy))) break; await page.waitForTimeout(80); } await page.waitForTimeout(extra); };
const vs = (page) => page.evaluate(() => ({ ...window.__vs }));
const screenOf = (page, expr) => page.evaluate((e) => { const p = eval(e); const xy = window.__deckgl.getViewports()[0].project(p); return [Math.round(xy[0]), Math.round(xy[1])]; }, expr);
const shot = async (page, name) => { const p = join(out, `deck3-${name}.png`); await page.screenshot({ path: p }); console.log("  → " + p); };
const needCount = async (page) => +((await page.textContent("#need .big")).match(/(\d+) 件/) || [0, 0])[1];
const inView = (p, w = 1440, h = 900) => p[0] > 30 && p[0] < w - 470 && p[1] > 80 && p[1] < h - 30;

if (only.includes("main")) {
  console.log("== 1440×900 ==");
  const { page, errors } = await open("v-deck3.html", 1440, 900, "#" + STYLES[0]);
  await settle(page, 600);
  let answered = false;
  for (const [si, style] of STYLES.entries()) {
    console.log(`-- ${style} --`);
    if (si) {
      // 用顶部的切换条换风格（真实点击）；幕布退掉之前不截图
      await page.locator(`#styles button[data-s="${style}"]`).click();
      await page.waitForTimeout(250);
      const mid = await page.evaluate(() => getComputedStyle(document.getElementById("veil")).opacity);
      await page.waitForTimeout(2600);
      const st = await page.evaluate(() => ({ s: document.body.dataset.style, h: location.hash, veil: getComputedStyle(document.getElementById("veil")).opacity, bg: getComputedStyle(document.getElementById("veil")).backgroundColor }));
      check(st.s === style && st.h.includes(style), `点切换条换到「${style}」，URL hash 记住`, st.h);
      check(+mid > 0.5 && +st.veil < 0.01, "切换时幕布先盖上（新风格的底色，不是白的）再退掉", `盖上时 ${(+mid).toFixed(2)} · ${st.bg} → ${st.veil}`);
      await page.keyboard.press("Escape"); await settle(page, 500);   // 没开窗口时 Esc 回到全局
    }
    const v0 = await vs(page);
    await shot(page, `${style}-far`);

    // 双击区域「10-31维护」→ 飞过去（中景）
    const rc = await screenOf(page, "window.__map.region('L-maint').center");
    await page.mouse.dblclick(rc[0], rc[1]);
    await settle(page, 700);
    const vm = await vs(page);
    check(vm.zoom > v0.zoom + 0.4, "双击区域飞过去", `zoom ${v0.zoom.toFixed(2)} → ${vm.zoom.toFixed(2)}`);
    await shot(page, `${style}-mid`);

    // 滚轮拉近到能看见所有牌子（近景），对着一个等你的节点滚
    const target = (await page.evaluate(() => window.__map.need()))[0];
    let p = await screenOf(page, `window.__map.pos('${target}')`);
    await page.mouse.move(p[0], p[1]);
    for (let i = 0; i < 8 && (await vs(page)).zoom < 13.35; i++) { await page.mouse.wheel(0, -220); await page.waitForTimeout(260); }
    await settle(page, 900);
    const vn = await vs(page), labs = await page.evaluate(() => window.__map.labs());
    check(vn.zoom > vm.zoom + 0.8, "滚轮拉近", `zoom → ${vn.zoom.toFixed(2)}`);
    check(labs.oth > 0 && labs.need > 0, "近景：等你的和其它节点的牌子都排出来了", JSON.stringify(labs));
    await shot(page, `${style}-near`);

    // 拖动平移
    const b0 = await vs(page);
    await page.mouse.move(640, 600); await page.mouse.down(); await page.mouse.move(520, 560, { steps: 12 }); await page.mouse.up();
    await settle(page, 300);
    const b1 = await vs(page);
    check(Math.abs(b1.longitude - b0.longitude) + Math.abs(b1.latitude - b0.latitude) > 1e-5, "拖动平移", `lng ${b0.longitude.toFixed(5)} → ${b1.longitude.toFixed(5)}`);

    // 点等你的节点 → 弹出窗口（节点不在视野里就先回全局）
    const need = await page.evaluate(() => window.__map.need());
    const nid = need.includes("r3") && !answered ? "r3" : need.find((x) => x !== "a9") || need[0];
    p = await screenOf(page, `window.__map.pos('${nid}')`);
    if (!inView(p)) { await page.keyboard.press("Escape"); await settle(page, 400); p = await screenOf(page, `window.__map.pos('${nid}')`); }
    await page.mouse.click(p[0], p[1]);
    await settle(page, 1300);
    const title = await page.textContent("#win h2").catch(() => "");
    check(await page.locator("#win.show").count() === 1 && (await page.evaluate(() => window.__map.sel)) === nid, `点等你的节点弹出窗口（${nid}）`, `点在 ${p} → ${title}`);
    check(await page.locator("#win .opt.rec").count() === 1 && (await page.textContent("#win .why").catch(() => "")).includes("推荐理由"), "推荐项标出来，写着理由");
    await shot(page, `${style}-popup`);

    if (!answered && nid === "r3") {
      // 在窗口里回答：写一句附言，点推荐的选项
      const before = await needCount(page);
      await page.locator("#win .note").click();
      await page.keyboard.type("午饭时间就行");
      await page.locator("#win .opt.rec").click();
      await page.waitForTimeout(600);
      const after = await needCount(page);
      check(after === before - 1, "在窗口里回答后数字减一", `${before} → ${after}`);
      check((await page.textContent("#win")).includes("已交回"), "窗口显示「已交回…进行中」");
      check(!(await page.evaluate(() => window.__map.need())).includes("r3"), "#22 不再是等你");
      await page.waitForTimeout(700);
      await shot(page, `${style}-answered`);
      answered = true;
    }
    // Esc 关窗口；再按一次回到全局
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    check(await page.locator("#win.show").count() === 0, "Esc 关闭窗口");
    const vz = (await vs(page)).zoom;
    await page.keyboard.press("Escape"); await settle(page, 300);
    check((await vs(page)).zoom < vz - 0.5, "没开窗口时 Esc 回到全局", `zoom ${vz.toFixed(2)} → ${(await vs(page)).zoom.toFixed(2)}`);

    // 「N 件等你」：依次飞到每一件
    const seen = [];
    for (let i = 0; i < 2; i++) {
      const b = await vs(page);
      await page.locator("#need").click(); await settle(page, 300);
      const a = await vs(page), sel = await page.evaluate(() => window.__map.sel);
      seen.push(sel);
      check(sel && (Math.hypot(a.longitude - b.longitude, a.latitude - b.latitude) > 1e-4 || Math.abs(a.zoom - b.zoom) > 0.2), `点「N 件等你」第 ${i + 1} 次：飞过去并打开`, `${sel}，zoom ${a.zoom.toFixed(2)}`);
    }
    check(new Set(seen).size === 2, "两次飞到不同的两件", seen.join(" → "));
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    await page.keyboard.press("Escape"); await settle(page, 400);
    // 滚轮缩放（在全局视角）
    const w0 = (await vs(page)).zoom;
    await page.mouse.move(720, 470); await page.mouse.wheel(0, 300); await settle(page, 300);
    check((await vs(page)).zoom < w0 - 0.1, "滚轮缩小", `zoom ${w0.toFixed(2)} → ${(await vs(page)).zoom.toFixed(2)}`);
    await page.keyboard.press("Escape"); await settle(page, 300);
  }
  // 空闲时 deck 的循环停下，只剩按风格帧率推的动画；页面不可见时全停
  await page.mouse.move(1300, 860); await page.waitForTimeout(1800);
  const idle = await page.evaluate(() => ({ loop: window.__map.loopOn, tick: window.__map.ticking }));
  check(!idle.loop && idle.tick, "空闲时 deck 的渲染循环停下，动画按风格帧率单独推", JSON.stringify(idle));
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(300);
  const hid = await page.evaluate(() => ({ loop: window.__map.loopOn, tick: window.__map.ticking }));
  check(!hid.loop && !hid.tick, "页面不可见时循环和动画都停", JSON.stringify(hid));
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.__map.ticking), "回到可见时动画恢复");
  await page.locator("#reset").click(); await page.waitForTimeout(400);
  check((await needCount(page)) === 5, "「恢复假数据」后回到 5 件");
  check(errors.length === 0, "页面没有报错", errors.join(" | "));
  await page.close();
}

if (only.includes("small")) {
  console.log("== 1280×800 ==");
  for (const style of STYLES) {
    const { page, errors } = await open("v-deck3.html", 1280, 800, "#" + style);
    await settle(page, 600);
    await shot(page, `${style}-far-1280`);
    await page.locator("#need").click(); await settle(page, 1300);
    check(await page.locator("#win.show").count() === 1, `1280 ${style}：点「N 件等你」打开窗口`);
    const box = await page.locator("#win").boundingBox();
    check(box.y + box.height <= 800 && box.x >= 0, "窗口没超出屏幕", JSON.stringify(box));
    const ov = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const a = r("#styles"), b = r("#tl"), c = r("#tr"); return a.left > b.right && a.right < c.left; });
    check(ov, "顶部切换条不压住左右两块 HUD");
    await shot(page, `${style}-popup-1280`);
    check(errors.length === 0, "页面没有报错", errors.join(" | "));
    await page.close();
  }
}

// ---------- 性能：所有文件用同一套方法（和 shot-deck2.mjs 一样） ----------
// 拖动：按住左键，不等待地连续 mouse.move 2 秒（来回晃 ±160px），每一帧视角都在变，都得重画。
// 计时插在 deck 实例上：setProps、layerManager.updateLayers、_pickAndCallback、_drawLayers 的耗时，另起一个 rAF 记帧间隔（rAF 帧率含合成器的负担：模糊、叠加层）。
const INSTRUMENT = () => {
  const d = window.__deckgl, P = (window.__P = { on: false });
  const reset = () => Object.assign(P, { setProps: 0, update: 0, pick: 0, draw: 0, draws: 0, ticks: 0, raf: [] });
  P.reset = reset; reset();
  const wrap = (obj, k, slot, count) => { const f = obj[k].bind(obj); obj[k] = (...a) => { const t = performance.now(); try { return f(...a); } finally { if (P.on) { P[slot] += performance.now() - t; if (count) P[count]++; } } }; };
  wrap(d, "setProps", "setProps"); wrap(d.layerManager, "updateLayers", "update"); wrap(d, "_pickAndCallback", "pick"); wrap(d, "_drawLayers", "draw", "draws");
  const tick = (t) => { if (P.on) P.raf.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
};
const START = () => { window.__P.reset(); window.__P.on = true; window.__P.t0 = performance.now(); if ("__fps" in window && window.__perf) { window.__fps = []; window.__perf = []; } };
const STOP = () => {
  const P = window.__P; P.on = false;
  const ms = performance.now() - P.t0, a = P.raf, d = [];
  for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]); d.sort((x, y) => x - y);
  const pf = window.__perf || [], build = pf.length ? pf.reduce((s, x) => s + x[0], 0) : 0;
  if ("__fps" in window) window.__fps = null;
  const per = (x) => (P.draws ? +(x / P.draws).toFixed(2) : 0);
  return { rafFps: +((a.length - 1) / ((a[a.length - 1] - a[0]) / 1000)).toFixed(1), drawsPerS: +(P.draws / (ms / 1000)).toFixed(1), p50: d.length ? +d[d.length >> 1].toFixed(1) : null, p95: d.length ? +d[Math.floor(d.length * 0.95)].toFixed(1) : null,
    cpuPerFrame: per(P.setProps + P.update + P.pick + P.draw + build), update: per(P.update), draw: per(P.draw) };
};
async function dragMeasure(page, ms = 2000) {
  await page.mouse.move(720, 470); await page.mouse.down(); await page.mouse.move(712, 470);
  await page.evaluate(START);
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) { i++; await page.mouse.move(720 + 160 * Math.sin(i / 14), 470 + 36 * Math.sin(i / 23)); }
  const r = await page.evaluate(STOP);
  await page.mouse.up();
  return r;
}
async function idleMeasure(page, ms = 2000) { await page.evaluate(START); await page.waitForTimeout(ms); return page.evaluate(STOP); }
const ZOOMS = { mid: 10.0, near: 13.9 };
async function wheelTo(page, z) {
  await page.mouse.move(720, 450);
  for (let i = 0; i < 30 && (await vs(page)).zoom < z - 0.05; i++) { await page.mouse.wheel(0, (await vs(page)).zoom < z - 0.8 ? -200 : -60); await page.waitForTimeout(220); }
  await page.waitForTimeout(1300);
}
async function perfFile(file, hash) {
  const { page, errors } = await open(file, 1440, 900, hash);
  await page.waitForTimeout(1500);
  await page.evaluate(INSTRUMENT);
  const res = {};
  await page.mouse.move(1300, 860); await page.waitForTimeout(1500);
  res.idle = await idleMeasure(page);
  res.far = { zoom: +(await vs(page)).zoom.toFixed(2), ...(await dragMeasure(page)) };
  await page.waitForTimeout(800);
  await wheelTo(page, ZOOMS.mid);
  res.mid = { zoom: +(await vs(page)).zoom.toFixed(2), ...(await dragMeasure(page)) };
  await page.waitForTimeout(800);
  await wheelTo(page, ZOOMS.near);
  res.near = { zoom: +(await vs(page)).zoom.toFixed(2), ...(await dragMeasure(page)) };
  if (errors.length) console.log("  页面报错：" + errors.join(" | "));
  await page.close();
  return res;
}
if (only.includes("perf")) {
  console.log("== 性能（#stress：200 条 lane、2000 个节点，同一套方法）==");
  const list = arg("--perf", "v-deck.html#stress,v-deck2.html#line&stress,v-deck3.html#oblivion&stress,v-deck3.html#oblivion&stress&nofx,v-deck3.html#nostromo&stress,v-deck3.html#nostromo&stress&nofx,v-deck3.html#abyss&stress,v-deck3.html#abyss&stress&nofx,v-deck3.html#haze&stress,v-deck3.html#haze&stress&nofx").split(",");
  for (const fh of list) {
    const [file, h] = fh.split("#");
    const r = await perfFile(file, "#" + h);
    console.log(`  ${fh}`);
    for (const lvl of ["idle", "far", "mid", "near"]) console.log(`    ${lvl.padEnd(5)} ${JSON.stringify(r[lvl])}`);
  }
}
await browser.close();
console.log(fails ? `${fails} 项没过` : "全部通过");
process.exit(fails ? 1 : 0);
