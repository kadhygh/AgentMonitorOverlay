// 验证 v-deck.html：一律用真实的鼠标事件（page.mouse / locator.click），页面里的函数只用来算坐标、读状态。
// 用法（在 studio/ 下）：node plans/userlayer/shot-deck.mjs [--only main,small,stress]
// 截图放 studio/screenshots/userlayer/deck-*.png；打印每一步的检查结果、页面报错和拖动时的帧率
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "../../screenshots/userlayer");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const only = (args[args.indexOf("--only") + 1] || "main,small,stress").split(",");
const url = pathToFileURL(join(dir, "v-deck.html")).href;
const browser = await chromium.launch({ channel: "msedge", args: ["--ignore-gpu-blocklist"] });
let fails = 0;
const check = (ok, what, extra = "") => { console.log((ok ? "  ✓ " : "  ✗ ") + what + (extra ? "  " + extra : "")); if (!ok) fails++; };

async function open(w, h, hash = "") {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url + hash);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(1800);
  return { page, errors };
}
const settle = async (page, extra = 350) => { await page.waitForTimeout(120); for (let i = 0; i < 80; i++) { if (!(await page.evaluate(() => window.__map.busy))) break; await page.waitForTimeout(80); } await page.waitForTimeout(extra); };
const vs = (page) => page.evaluate(() => ({ ...window.__vs }));
// 节点（或任意经纬度 + 高度）在屏幕上的位置：deck.getViewports()[0].project
const screenOf = (page, expr) => page.evaluate((e) => { const p = eval(e); const xy = window.__deckgl.getViewports()[0].project(p); return [Math.round(xy[0]), Math.round(xy[1])]; }, expr);
const shot = async (page, name) => { const p = join(out, `deck-${name}.png`); await page.screenshot({ path: p }); console.log("  → " + p); };
async function fps(page, label, steps = 60) {
  await page.evaluate(() => (window.__fps = []));
  await page.mouse.move(700, 480); await page.mouse.down();
  for (let i = 0; i < steps; i++) { await page.mouse.move(700 - i * 7, 480 + Math.sin(i / 6) * 50); await page.waitForTimeout(16); }
  await page.mouse.up();
  const f = await page.evaluate(() => { const a = window.__fps, pf = window.__perf; window.__fps = null; window.__perf = []; const avg = (k) => +(pf.reduce((s, x) => s + x[k], 0) / pf.length).toFixed(2); const m = window.__deckgl.metrics; const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]); d.sort((x, y) => x - y); const ms = a[a.length - 1] - a[0]; return { frames: a.length, ms: Math.round(ms), fps: +((a.length - 1) / (ms / 1000)).toFixed(1), p50: +d[d.length >> 1].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1), max: +d[d.length - 1].toFixed(1), layersMs: avg(0), setPropsMs: avg(1), deckCpuMs: m && +(m.cpuTimePerFrame || 0).toFixed(2), deckGpuMs: m && +(m.gpuTimePerFrame || 0).toFixed(2), deckFps: m && +(m.fps || 0).toFixed(1) }; });
  console.log(`  帧率 ${label}: ${JSON.stringify(f)}`);
  return f;
}

if (only.includes("main")) {
  console.log("== 1440×900 ==");
  const { page, errors } = await open(1440, 900);
  const v0 = await vs(page);
  check(v0.pitch > 30, "倾斜视角", `zoom ${v0.zoom.toFixed(2)} pitch ${v0.pitch}`);
  check((await page.textContent("#need .big")).includes("5 件等你"), "右上角「! 5 件等你」", await page.textContent("#need .big"));
  await shot(page, "mid");

  // 滚轮拉远 → 远
  await page.mouse.move(720, 450);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 160); await page.waitForTimeout(60); }
  await settle(page, 700);
  const v1 = await vs(page);
  check(v1.zoom < v0.zoom - 0.5, "滚轮拉远，zoom 变小", `${v0.zoom.toFixed(2)} → ${v1.zoom.toFixed(2)}`);
  await shot(page, "far");

  // 拖动平移
  const before = await vs(page);
  await page.mouse.move(700, 500); await page.mouse.down(); await page.mouse.move(560, 430, { steps: 12 }); await page.mouse.up();
  await settle(page, 500);
  const after = await vs(page);
  check(Math.abs(after.longitude - before.longitude) > 1e-4 && Math.abs(after.latitude - before.latitude) > 1e-5, "拖动平移，中心变了", `lng ${before.longitude.toFixed(4)} → ${after.longitude.toFixed(4)}`);
  // Ctrl 拖动：旋转和倾斜
  await page.keyboard.down("Control");
  await page.mouse.move(700, 500); await page.mouse.down(); await page.mouse.move(800, 470, { steps: 12 }); await page.mouse.up();
  await page.keyboard.up("Control");
  await settle(page, 500);
  const rot = await vs(page);
  check(Math.abs(rot.bearing - after.bearing) > 3, "Ctrl 拖动旋转", `bearing ${after.bearing.toFixed(1)} → ${rot.bearing.toFixed(1)}，pitch ${after.pitch.toFixed(1)} → ${rot.pitch.toFixed(1)}`);
  // 右键拖动
  await page.mouse.move(700, 500); await page.mouse.down({ button: "right" }); await page.mouse.move(700, 440, { steps: 10 }); await page.mouse.up({ button: "right" });
  await settle(page, 500);
  const rot2 = await vs(page);
  check(Math.abs(rot2.pitch - rot.pitch) > 2 || Math.abs(rot2.bearing - rot.bearing) > 2, "右键拖动调倾斜", `pitch ${rot.pitch.toFixed(1)} → ${rot2.pitch.toFixed(1)}`);

  // 重置视角（按钮）
  await page.locator("#home").click(); await settle(page, 500);
  const vh = await vs(page);
  check(Math.abs(vh.zoom - v0.zoom) < 0.3 && Math.abs(vh.bearing - v0.bearing) < 1, "「重置视角」回到全部任务", `zoom ${vh.zoom.toFixed(2)}`);

  // 点区域名 → 飞过去框住它
  const nm = await screenOf(page, "window.__map.region('L-maint').name");
  await page.mouse.click(nm[0] + 30, nm[1] + 9);
  await settle(page, 600);
  const vr = await vs(page);
  check(vr.zoom > vh.zoom + 0.5, "点区域名「10-31维护」飞过去", `zoom ${vh.zoom.toFixed(2)} → ${vr.zoom.toFixed(2)}`);
  await shot(page, "region");
  // 回到全局，再双击另一块区域
  await page.locator("#home").click(); await settle(page, 400);
  const rc = await screenOf(page, "window.__map.region('L-and').center");
  await page.mouse.dblclick(rc[0], rc[1] + 14);
  await settle(page, 600);
  const vd = await vs(page);
  check(vd.zoom > vh.zoom + 0.5, "双击区域「安卓版」飞过去", `zoom → ${vd.zoom.toFixed(2)}，屏幕点 ${rc}`);

  // 滚轮拉近 → 近
  await page.mouse.move(720, 470);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(60); }
  await settle(page, 800);
  const vn = await vs(page);
  check(vn.zoom > vd.zoom + 0.4, "滚轮拉近", `zoom → ${vn.zoom.toFixed(2)}`);
  await shot(page, "near");

  // 点节点 → 弹出窗口（#22 何时部署）
  await page.locator("#home").click(); await settle(page, 400);
  await page.mouse.move(720, 450);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(60); }
  await settle(page, 700);
  let p = await screenOf(page, "window.__map.pos('r3')");
  // 如果不在屏幕里就先飞到所在区域
  if (p[0] < 20 || p[0] > 1420 || p[1] < 20 || p[1] > 880) { const n2 = await screenOf(page, "window.__map.region('L-maint').center"); await page.mouse.dblclick(n2[0], n2[1]); await settle(page, 600); p = await screenOf(page, "window.__map.pos('r3')"); }
  await page.mouse.click(p[0], p[1]);
  await page.waitForTimeout(250);
  check(await page.locator("#win.show").count() === 1, "点节点 #22 弹出窗口", `点在 ${p}`);
  check((await page.textContent("#win h2")).includes("部署"), "窗口是 #22", await page.textContent("#win h2"));
  await settle(page, 600);
  await shot(page, "popup");
  // Esc 关闭
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  check(await page.locator("#win.show").count() === 0, "Esc 关闭窗口");

  // 点牌子 → 弹出窗口（#23 中断怎么记，牌子在节点上方）
  const lp = await screenOf(page, "window.__map.labelPos('r4')");
  await page.mouse.click(lp[0], lp[1] - 14);
  await page.waitForTimeout(250);
  check(await page.locator("#win.show").count() === 1 && (await page.textContent("#win h2")).includes("中断"), "点牌子 #23 弹出窗口", `点在 ${lp[0]},${lp[1] - 14}：${await page.textContent("#win h2").catch(() => "")}`);
  await settle(page, 500);

  // 在窗口里回答：附一句话，点推荐项
  const needBefore = await page.textContent("#need .big");
  await page.locator("#win .note").click();
  await page.keyboard.type("关机不算失败");
  await page.locator("#win .opt.rec").click();
  await page.waitForTimeout(500);
  await shot(page, "answer-mid");
  await page.waitForTimeout(1300);
  const needAfter = await page.textContent("#need .big");
  check(needAfter.includes("4 件等你"), "回答后告警收起：等你 5 → 4", `${needBefore} → ${needAfter}`);
  check((await page.textContent("#win")).includes("已交回"), "窗口显示「已交回…进行中」");
  const col = await page.evaluate(() => { const n = window.__deckgl.props.layers.find((l) => l.id === "nodes").props.data.find((d) => d.id === "r4"); return n.col.join(","); });
  check(col === "0,229,255", "节点 #23 由琥珀变青", col);
  await shot(page, "answer");
  // 前端推进：回答 #11（10-31维护的最后一个闸门）
  const fx0 = await page.evaluate(() => window.__deckgl.props.layers.find((l) => l.id === "front").props.data.find((d) => d.r.id === "L-maint").p[0]);
  await page.locator("#need").click(); await settle(page, 500);
  let guard = 0;
  while (!(await page.textContent("#win h2")).includes("收尾") && guard++ < 5) { await page.locator("#need").click(); await settle(page, 400); }
  await page.locator("#win .opt.rec").click();
  await page.waitForTimeout(1800);
  const fx1 = await page.evaluate(() => window.__deckgl.props.layers.find((l) => l.id === "front").props.data.find((d) => d.r.id === "L-maint").p[0]);
  check(fx1 > fx0, "回答 #11 后 10-31维护 的前端往前推", `${fx0.toFixed(5)} → ${fx1.toFixed(5)}`);
  await shot(page, "answer-front");

  // 「! N 件等你」：依次飞到每一件
  await page.keyboard.press("Escape");
  await page.locator("#home").click(); await settle(page, 400);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const b = await vs(page);
    await page.locator("#need").click(); await settle(page, 400);
    const a = await vs(page);
    const sel = await page.evaluate(() => window.__map.sel);
    seen.push(sel);
    check(Math.hypot(a.longitude - b.longitude, a.latitude - b.latitude) > 1e-4 || Math.abs(a.zoom - b.zoom) > 0.2, `点「等你」第 ${i + 1} 次：飞过去并打开`, `${sel}，zoom ${a.zoom.toFixed(2)}`);
  }
  check(new Set(seen).size === 3, "三次飞到三件不同的", seen.join(" → "));
  await shot(page, "need-cycle");

  // 关联：在窗口里点关联，飞过去并打开那一条
  const curSel = await page.evaluate(() => window.__map.sel);
  const lk = page.locator("#win .lk").first();
  if (await lk.count()) {
    await lk.click(); await settle(page, 400);
    const ns = await page.evaluate(() => window.__map.sel);
    check(ns && ns !== curSel, "点关联飞到那个节点并打开", `${curSel} → ${ns}`);
    await shot(page, "link");
  } else check(false, "窗口里有关联可点");

  // 恢复假数据
  await page.locator("#reset").click(); await page.waitForTimeout(500);
  check((await page.textContent("#need .big")).includes("5 件等你"), "恢复假数据后回到 5 件");
  await page.locator("#home").click(); await settle(page, 400);
  await fps(page, "1440 正常数据，全局拖动");
  check(errors.length === 0, "页面没有报错", errors.join(" | "));
  await page.close();
}

if (only.includes("small")) {
  console.log("== 1280×800 ==");
  const { page, errors } = await open(1280, 800);
  await shot(page, "mid-1280");
  await page.locator("#need").click(); await settle(page, 500);
  check(await page.locator("#win.show").count() === 1, "1280 点「等你」打开窗口");
  await shot(page, "popup-1280");
  const box = await page.locator("#win").boundingBox();
  check(box.y + box.height <= 800 && box.x >= 0, "窗口没超出屏幕", JSON.stringify(box));
  check(errors.length === 0, "页面没有报错", errors.join(" | "));
  await page.close();
}

if (only.includes("stress")) {
  console.log("== #stress ==");
  const { page, errors } = await open(1440, 900, "#stress");
  await page.waitForTimeout(1500);
  const n = await page.evaluate(() => window.__deckgl.props.layers.find((l) => l.id === "region").props.data.length);
  check(n >= 200, "压力数据：区域数", String(n));
  await shot(page, "stress-far");
  await fps(page, "stress 远（全局）");
  // 拉近到中景
  await page.mouse.move(720, 450);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(50); }
  await settle(page, 900);
  console.log("  zoom", (await vs(page)).zoom.toFixed(2));
  await shot(page, "stress-mid");
  await fps(page, "stress 中景");
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(50); }
  await settle(page, 900);
  console.log("  zoom", (await vs(page)).zoom.toFixed(2));
  await shot(page, "stress-near");
  await fps(page, "stress 近景");
  check(errors.length === 0, "页面没有报错", errors.join(" | "));
  await page.close();
}
await browser.close();
console.log(fails ? `${fails} 项没过` : "全部通过");
process.exit(fails ? 1 : 0);
