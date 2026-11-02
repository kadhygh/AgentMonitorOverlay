// 验证 v-deck2.html：一律用真实的鼠标事件（page.mouse / locator.click），页面里的函数只用来算坐标、读状态。
// 用法（在 studio/ 下）：node plans/userlayer/shot-deck2.mjs [--only main,small,perf]
//   main：三种风格的交互和截图（studio/screenshots/userlayer/deck2-<风格>-*.png）
//   small：1280×800
//   perf：v-deck.html 和 v-deck2.html 用同一套方法测 #stress 远、中、近三档的拖动帧率和 deck 每帧 CPU 时间，以及空闲时还画不画
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "../../screenshots/userlayer");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const only = (args.includes("--only") ? args[args.indexOf("--only") + 1] : "main,small,perf").split(",");
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
  await page.waitForTimeout(2000);
  return { page, errors };
}
const settle = async (page, extra = 300) => { await page.waitForTimeout(120); for (let i = 0; i < 100; i++) { if (!(await page.evaluate(() => window.__map.busy))) break; await page.waitForTimeout(80); } await page.waitForTimeout(extra); };
const vs = (page) => page.evaluate(() => ({ ...window.__vs }));
const screenOf = (page, expr) => page.evaluate((e) => { const p = eval(e); const xy = window.__deckgl.getViewports()[0].project(p); return [Math.round(xy[0]), Math.round(xy[1])]; }, expr);
const shot = async (page, name) => { const p = join(out, `deck2-${name}.png`); await page.screenshot({ path: p }); console.log("  → " + p); };
const needText = (page) => page.textContent("#need");
const inView = (p, w = 1440, h = 900) => p[0] > 20 && p[0] < w - 20 && p[1] > 60 && p[1] < h - 20;

async function styleRun(page, style, first) {
  console.log(`-- ${style} --`);
  if (!first) {
    // 用顶部的切换条换风格（真实点击）
    await page.locator(`#styles button[data-s="${style}"]`).click();
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.body.dataset.style) === style && (await page.evaluate(() => location.hash)).includes(style), `切换到「${style}」，URL hash 记住`, await page.evaluate(() => location.hash));
    await page.keyboard.press("Escape"); await settle(page, 500);  // Esc：没开窗口时回到全局
  }
  await settle(page, 600);
  await shot(page, `${style}-far`);
}

if (only.includes("main")) {
  console.log("== 1440×900 ==");
  const { page, errors } = await open("v-deck2.html", 1440, 900, "#line");
  await settle(page, 400);
  check((await needText(page)).includes("5 件等你"), "右上角「5 件等你」", await needText(page));
  // 空闲时循环停下，呼吸在跑（有等你的）
  await page.waitForTimeout(1500);
  const idle = await page.evaluate(() => ({ loop: window.__map.loopOn, br: window.__map.breathing }));
  check(!idle.loop && idle.br, "空闲时 deck 的渲染循环停下，只有呼吸在低帧率跑", JSON.stringify(idle));

  for (const style of ["line", "star", "chart"]) {
    await styleRun(page, style, style === "line");
    const v0 = await vs(page);

    // 悬停普通节点 → 出现短标题
    const hv = await screenOf(page, "window.__map.pos('f3')");
    await page.mouse.move(hv[0], hv[1]); await page.waitForTimeout(350);
    const h = await page.evaluate(() => window.__map.hover);
    const hasLayer = await page.evaluate(() => !!window.__deckgl.props.layers.find((l) => l.id === "hover"));
    check(h === "f3" && hasLayer, "悬停普通节点出现短标题", `悬停 ${hv} → ${h}`);
    if (style === "line") await shot(page, `${style}-hover`);
    await page.mouse.move(40, 840); await page.waitForTimeout(250);
    check(await page.evaluate(() => window.__map.hover) === null, "移开后短标题消失");

    // 双击区域 → 飞过去
    const rc = await screenOf(page, "window.__map.region('L-maint').center");
    await page.mouse.dblclick(rc[0], rc[1]);
    await settle(page, 500);
    const vd = await vs(page);
    check(vd.zoom > v0.zoom + 0.5, "双击区域「10-31维护」飞过去", `zoom ${v0.zoom.toFixed(2)} → ${vd.zoom.toFixed(2)}`);
    // 再滚轮拉近一点 → 近景
    await page.mouse.move(720, 470);
    for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(60); }
    await settle(page, 600);
    const vn = await vs(page);
    check(vn.zoom > vd.zoom + 0.2, "滚轮拉近", `zoom → ${vn.zoom.toFixed(2)}`);
    await shot(page, `${style}-near`);

    // 点等你的节点 → 弹出窗口（线稿点 #22 并回答它；之后的风格点还在等你的 #23）
    const [nid, nnum, nword] = style === "line" ? ["r3", 22, "部署"] : ["r4", 23, "中断"];
    let p = await screenOf(page, `window.__map.pos('${nid}')`);
    if (!inView(p)) { await page.keyboard.press("Escape"); await settle(page, 400); p = await screenOf(page, `window.__map.pos('${nid}')`); }
    await page.mouse.click(p[0], p[1]);
    await page.waitForTimeout(250);
    check(await page.locator("#win.show").count() === 1 && (await page.textContent("#win h2")).includes(nword), `点等你的节点 #${nnum} 弹出窗口`, `点在 ${p}`);
    check(await page.locator("#win .opt.on.rec").count() === 1, "推荐项默认选中，写着理由", await page.textContent("#win .why").catch(() => ""));
    check(await page.locator("#win details:not([open])").count() === 1, "正文、证据、关联收在「更多」里，默认折起");
    await settle(page, 500);
    await shot(page, `${style}-popup`);

    if (style === "line") {
      // 在窗口里回答：点一个选项、写附言、点「回答」
      const before = await needText(page);
      await page.locator('#win .opt[data-opt="noon"]').click();
      await page.locator("#win .note").click();
      await page.keyboard.type("午饭时间就行");
      await page.locator('#win [data-act="answer"]').click();
      await page.waitForTimeout(500);
      const after = await needText(page);
      check(after.includes("4 件等你"), "回答后数字减一", `${before} → ${after}`);
      check((await page.textContent("#win")).includes("已交回"), "窗口显示「已交回…进行中」");
      const st = await page.evaluate(() => ({ need: window.__map.need().includes("r3"), core: window.__deckgl.props.layers.find((l) => l.id === "need").props.data.some((n) => n.id === "r3") }));
      check(!st.need && !st.core, "#22 不再是等你，变成普通点", JSON.stringify(st));
      await settle(page, 400);
      await shot(page, `${style}-answered`);
      // 「更多」展开
      await page.locator("#win summary").click(); await page.waitForTimeout(150);
      check(await page.locator("#win details[open] .more").count() === 1, "点「更多」展开");
    }
    // Esc 关窗口
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    check(await page.locator("#win.show").count() === 0, "Esc 关闭窗口");
    // 再按一次 Esc：没开窗口时回到全局
    const vz = (await vs(page)).zoom;
    await page.keyboard.press("Escape"); await settle(page, 300);
    check((await vs(page)).zoom < vz - 0.5, "没开窗口时 Esc 回到全局", `zoom ${vz.toFixed(2)} → ${(await vs(page)).zoom.toFixed(2)}`);

    // 「N 件等你」：依次飞到每一件
    const seen = [];
    for (let i = 0; i < 2; i++) {
      const b = await vs(page);
      await page.locator("#need").click(); await settle(page, 300);
      const a = await vs(page);
      const sel = await page.evaluate(() => window.__map.sel);
      seen.push(sel);
      check(Math.hypot(a.longitude - b.longitude, a.latitude - b.latitude) > 1e-4 || Math.abs(a.zoom - b.zoom) > 0.2, `点「N 件等你」第 ${i + 1} 次：飞过去并打开`, `${sel}，zoom ${a.zoom.toFixed(2)}`);
    }
    check(new Set(seen).size === 2, "两次飞到不同的两件", seen.join(" → "));
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  }

  // 拖动、Ctrl 拖动、右键拖动
  console.log("-- 视角操作 --");
  await page.keyboard.press("Escape"); await settle(page, 400);
  const b0 = await vs(page);
  await page.mouse.move(700, 500); await page.mouse.down(); await page.mouse.move(560, 430, { steps: 12 }); await page.mouse.up();
  await settle(page, 400);
  const b1 = await vs(page);
  check(Math.abs(b1.longitude - b0.longitude) > 1e-4, "拖动平移", `lng ${b0.longitude.toFixed(4)} → ${b1.longitude.toFixed(4)}`);
  await page.keyboard.down("Control");
  await page.mouse.move(700, 500); await page.mouse.down(); await page.mouse.move(800, 470, { steps: 12 }); await page.mouse.up();
  await page.keyboard.up("Control");
  await settle(page, 400);
  const b2 = await vs(page);
  check(Math.abs(b2.bearing - b1.bearing) > 3, "Ctrl 拖动旋转", `bearing ${b1.bearing.toFixed(1)} → ${b2.bearing.toFixed(1)}`);
  await page.mouse.move(700, 500); await page.mouse.down({ button: "right" }); await page.mouse.move(700, 440, { steps: 10 }); await page.mouse.up({ button: "right" });
  await settle(page, 400);
  const b3 = await vs(page);
  check(Math.abs(b3.pitch - b2.pitch) > 2, "右键拖动调倾斜", `pitch ${b2.pitch.toFixed(1)} → ${b3.pitch.toFixed(1)}`);
  // 牌子：拖动中不重排，停下来之后排一次
  const lv0 = await page.evaluate(() => window.__deckgl.props.layers.find((l) => l.id === "need-lab").props.updateTriggers.getPixelOffset);
  await page.mouse.move(700, 500); await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(700 - i * 6, 500 - i * 3);
  const lvMid = await page.evaluate(() => window.__deckgl.props.layers.find((l) => l.id === "need-lab").props.updateTriggers.getPixelOffset);
  await page.mouse.up();
  check(lvMid === lv0, "拖动过程中牌子不重排", `版本 ${lv0} → ${lvMid}`);

  // 双击空白处回到全局
  await page.mouse.dblclick(80, 820); await settle(page, 400);
  // 恢复假数据
  await page.locator("#reset").click(); await page.waitForTimeout(400);
  check((await needText(page)).includes("5 件等你"), "「恢复假数据」后回到 5 件", await needText(page));
  // 页面不可见：呼吸和循环都停
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(300);
  const hid = await page.evaluate(() => ({ loop: window.__map.loopOn, br: window.__map.breathing }));
  check(!hid.loop && !hid.br, "页面不可见时循环和呼吸都停", JSON.stringify(hid));
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.__map.breathing), "回到可见时呼吸恢复");
  check(errors.length === 0, "页面没有报错", errors.join(" | "));
  await page.close();
}

if (only.includes("small")) {
  console.log("== 1280×800 ==");
  for (const style of ["line", "star", "chart"]) {
    const { page, errors } = await open("v-deck2.html", 1280, 800, "#" + style);
    await settle(page, 400);
    await shot(page, `${style}-far-1280`);
    await page.locator("#need").click(); await settle(page, 500);
    check(await page.locator("#win.show").count() === 1, `1280 ${style}：点「等你」打开窗口`);
    const box = await page.locator("#win").boundingBox();
    check(box.y + box.height <= 800 && box.x >= 0, "窗口没超出屏幕", JSON.stringify(box));
    await shot(page, `${style}-popup-1280`);
    check(errors.length === 0, "页面没有报错", errors.join(" | "));
    await page.close();
  }
}

// ---------- 性能：两个文件用同一套方法 ----------
// 拖动：按住左键，不等待地连续 mouse.move 2 秒（来回晃 ±160px），两边每一帧视角都在变，都得重画。
// 计时插在 deck 实例上（两边一样）：setProps、layerManager.updateLayers、_pickAndCallback、_drawLayers 的耗时，
// 页面自己每帧建图层的耗时（v-deck.html 的 window.__perf），以及另起一个 rAF 记帧间隔。
const INSTRUMENT = () => {
  const d = window.__deckgl, P = (window.__P = { on: false });
  const reset = () => Object.assign(P, { setProps: 0, update: 0, pick: 0, draw: 0, draws: 0, ticks: 0, raf: [] });
  P.reset = reset; reset();
  const wrap = (obj, k, slot, count) => { const f = obj[k].bind(obj); obj[k] = (...a) => { const t = performance.now(); try { return f(...a); } finally { if (P.on) { P[slot] += performance.now() - t; if (count) P[count]++; } } }; };
  wrap(d, "setProps", "setProps"); wrap(d.layerManager, "updateLayers", "update"); wrap(d, "_pickAndCallback", "pick"); wrap(d, "_drawLayers", "draw", "draws");
  const al = d.animationLoop, r0 = al.redraw.bind(al); al.redraw = (...a) => { if (P.on) P.ticks++; return r0(...a); };
  const tick = (t) => { if (P.on) P.raf.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
};
const START = () => { window.__P.reset(); window.__P.on = true; window.__P.t0 = performance.now(); if ("__fps" in window && window.__perf) { window.__fps = []; window.__perf = []; } };
const STOP = () => {
  const P = window.__P; P.on = false;
  const ms = performance.now() - P.t0, a = P.raf, d = [];
  for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]); d.sort((x, y) => x - y);
  const pf = window.__perf || [], build = pf.length ? pf.reduce((s, x) => s + x[0], 0) : 0;
  if ("__fps" in window) window.__fps = null;
  const m = window.__deckgl.metrics, per = (x) => (P.draws ? +(x / P.draws).toFixed(2) : 0);
  return { s: +(ms / 1000).toFixed(2), rafFps: +((a.length - 1) / ((a[a.length - 1] - a[0]) / 1000)).toFixed(1), drawsPerS: +(P.draws / (ms / 1000)).toFixed(1), loopTicksPerS: +(P.ticks / (ms / 1000)).toFixed(1),
    p50: d.length ? +d[d.length >> 1].toFixed(1) : null, p95: d.length ? +d[Math.floor(d.length * 0.95)].toFixed(1) : null,
    cpuPerFrame: per(P.setProps + P.update + P.pick + P.draw + build), pageBuild: per(build), setProps: per(P.setProps), update: per(P.update), pick: per(P.pick), draw: per(P.draw),
    deckCpuMetric: +(m.cpuTimePerFrame || 0).toFixed(2), deckGpuMetric: +(m.gpuTimePerFrame || 0).toFixed(2) };
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
// 三档用真实滚轮拉到同样的缩放级别再拖（两个文件的全局视角不完全一样，按滚动次数会差开）
const ZOOMS = { stress: { mid: 10.0, near: 13.9 }, real: { mid: 12.4, near: 13.9 } };
async function wheelTo(page, z) {
  await page.mouse.move(720, 450);
  for (let i = 0; i < 30 && (await vs(page)).zoom < z - 0.05; i++) { await page.mouse.wheel(0, (await vs(page)).zoom < z - 0.8 ? -200 : -60); await page.waitForTimeout(220); }
  await page.waitForTimeout(1300);
}
async function perfFile(file, hash) {
  const { page, errors } = await open(file, 1440, 900, hash);
  await page.waitForTimeout(1500);
  await page.evaluate(INSTRUMENT);
  const Z = ZOOMS[hash.includes("stress") ? "stress" : "real"], res = {};
  await page.mouse.move(1300, 860); await page.waitForTimeout(1500);
  res.idle = await idleMeasure(page);
  res.far = { zoom: +(await vs(page)).zoom.toFixed(2), ...(await dragMeasure(page)) };
  await page.waitForTimeout(800);
  await wheelTo(page, Z.mid);
  res.mid = { zoom: +(await vs(page)).zoom.toFixed(2), ...(await dragMeasure(page)) };
  await page.waitForTimeout(800);
  await wheelTo(page, Z.near);
  res.near = { zoom: +(await vs(page)).zoom.toFixed(2), ...(await dragMeasure(page)) };
  const name = file.replace(".html", "");
  await page.screenshot({ path: join(out, `deck2-perf-${name}${hash.replace(/[#&]/g, "-")}-near.png`) });
  // 没有等你的事时：v-deck2 的循环和呼吸都该停，一帧都不画（这里用读写层直接回答，只为造出这个状态）
  if (file === "v-deck2.html") {
    await page.evaluate(() => { for (const it of AMO.needsYou()) it.ask ? AMO.answer(it.id, it.ask.recommend || it.ask.options[0].id, "") : AMO.park(it.id, ""); });
    await page.mouse.move(1300, 860); await page.waitForTimeout(1800);
    res.idle0 = await idleMeasure(page);
    await page.evaluate(() => AMO.reset());
  }
  if (errors.length) console.log("  页面报错：" + errors.join(" | "));
  await page.close();
  return res;
}

if (only.includes("perf")) {
  console.log("== 性能（同一套方法）==");
  const rounds = +(args.includes("--rounds") ? args[args.indexOf("--rounds") + 1] : 1);
  for (let k = 0; k < rounds; k++) {
    for (const [file, hash] of [["v-deck.html", "#stress"], ["v-deck2.html", "#line&stress"], ["v-deck2.html", "#star&stress"], ["v-deck.html", ""], ["v-deck2.html", "#line"]]) {
      const r = await perfFile(file, hash);
            console.log(`  ${file}${hash}`);
      for (const lvl of ["idle", "idle0", "far", "mid", "near"]) if (r[lvl]) console.log(`    ${lvl.padEnd(5)} ${JSON.stringify(r[lvl])}`);
    }
  }
}
await browser.close();
console.log(fails ? `${fails} 项没过` : "全部通过");
process.exit(fails ? 1 : 0);
