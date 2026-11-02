// 给 v-lanes.html 截交互状态：每种方向 × 浅色/深色 × 状态（大地图、单个任务、子车道、弹出窗口、回答后）。
// 用法（在 studio/ 下）：node plans/userlayer/shot-lanes.mjs [right away radial free] [--states overview,task,split,popup,answer] [--w 1440 --h 900] [--schemes light,dark]
// 截图放 studio/screenshots/userlayer/lanes-<方向>-<状态>-<浅深>.png；同时打印页面报错和拖动时的帧率
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const modes = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const states = opt("--states", "overview,task,split,popup,answer").split(",");
const schemes = opt("--schemes", "light,dark").split(",");
const w = +opt("--w", 1440), h = +opt("--h", 900), fps = args.includes("--fps");
const out = join(dir, "../../screenshots/userlayer");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "msedge" });
const settle = async (page) => { for (let i = 0; i < 60; i++) { if (!(await page.evaluate(() => window.__lanes.busy))) break; await page.waitForTimeout(80); } await page.waitForTimeout(250); };
for (const mode of modes.length ? modes : ["right", "away", "radial", "free"]) {
  for (const scheme of schemes) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(pathToFileURL(join(dir, "v-lanes.html")).href + "#" + mode);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(500);
    const shot = async (st) => { const p = join(out, `lanes-${mode}-${st}-${scheme}${w !== 1440 ? "-" + w : ""}.png`); await page.screenshot({ path: p }); console.log(p); };
    for (const st of states) {
      if (st === "overview") { await page.evaluate(() => { window.__lanes.closeWin(); window.__lanes.flyAll(); }); await settle(page); await shot(st); }
      if (st === "task") { await page.evaluate(() => { window.__lanes.closeWin(); window.__lanes.flyToLane("L-and"); }); await settle(page); await shot(st); }
      if (st === "maint") { await page.evaluate(() => { window.__lanes.closeWin(); window.__lanes.flyToLane("L-maint"); }); await settle(page); await shot(st); }
      if (st === "split") { await page.evaluate(() => { window.__lanes.closeWin(); window.__lanes.flyToLane("L-rev"); }); await settle(page); await shot(st); }
      if (st === "flow") { await page.evaluate(() => { window.__lanes.closeWin(); window.__lanes.flyToLane("L-flow"); }); await settle(page); await shot(st); }
      if (st === "popup") { await page.click("#need"); await settle(page); await shot(st); }
      if (st === "answer") {
        await page.evaluate(() => { const it = window.AMO.needsYou()[0]; window.__lanes.flyToItem(it.id); });
        await settle(page);
        await page.locator("#win .opt").filter({ has: page.locator(".rec") }).first().click();
        await page.fill("#win input.note", "午饭时间可以");
        await page.click('#win [data-act="send"]');
        await page.waitForTimeout(600); await shot("answer-mid");
        await page.waitForTimeout(1300); await shot(st);
      }
    }
    if (fps) {
      // 拖动 1.5 秒，数帧
      await page.evaluate(() => { window.__lanes.closeWin(); window.__lanes.flyToLane("L-maint"); });
      await settle(page);
      await page.evaluate(() => (window.__fps = []));
      await page.mouse.move(700, 450); await page.mouse.down();
      for (let i = 0; i < 45; i++) { await page.mouse.move(700 - i * 8, 450 + Math.sin(i / 5) * 40); await page.waitForTimeout(33); }
      await page.mouse.up();
      const f = await page.evaluate(() => { const a = window.__fps; const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]); d.sort((x, y) => x - y); return { frames: a.length, ms: a.length > 1 ? a[a.length - 1] - a[0] : 0, p50: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)] }; });
      console.log("drag fps", mode, scheme, JSON.stringify(f));
    }
    console.log(mode, scheme, errors.length ? "ERRORS: " + errors.join(" | ") : "ok");
    await page.close();
  }
}
await browser.close();
