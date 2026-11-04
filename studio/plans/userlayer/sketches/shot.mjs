// 截概念图：每张 SVG 单独截一张（看细节），再截入口页每个方向的一节（平看、倾斜看各一张）。
// 用法（在 studio/ 下）：node plans/userlayer/sketches/shot.mjs [--only svg|page] [--dirs terrain,metro] [--url http://100.107.87.64:47130/sketches.html]
import { chromium } from "playwright";
import { mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, "../../../screenshots/userlayer");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const only = arg("--only", "svg,page").split(",");
const DIRS = arg("--dirs", "terrain,metro").split(",");
const url = arg("--url", "http://100.107.87.64:47130/sketches.html");
const browser = await chromium.launch({ channel: "msedge" });

if (only.includes("svg")) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg") && DIRS.includes(f.split("-")[0]))) {
    await page.goto(pathToFileURL(join(dir, f)).href);
    await page.waitForTimeout(300);
    const p = join(out, `sketch-${f.replace(".svg", ".png")}`);
    await page.screenshot({ path: p });
    console.log("→ " + p);
  }
  await page.close();
}
if (only.includes("page")) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForTimeout(800);
  for (const d of DIRS) {
    const sec = page.locator(`#${d}`);
    if (!(await sec.count())) { console.log("没有这一节：" + d); continue; }
    await sec.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const box = await sec.boundingBox(), sy = await page.evaluate(() => scrollY);
    const clip = { x: Math.max(0, box.x - 16), y: box.y + sy - 8, width: box.width + 32, height: box.height + 16 };
    await page.screenshot({ path: join(out, `sketch-${d}.png`), clip, fullPage: true });
    for (const b of await sec.locator("button.tilt").all()) await b.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(out, `sketch-${d}-tilt.png`), clip, fullPage: true });
    for (const b of await sec.locator("button.tilt").all()) await b.click();
    console.log("→ sketch-" + d + "(.png, -tilt.png)");
  }
  await page.screenshot({ path: join(out, "sketch-page-top.png") });
  if (errors.length) console.log("页面报错：\n" + errors.join("\n"));
  await page.close();
}
await browser.close();
