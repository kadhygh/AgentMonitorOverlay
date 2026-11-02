// 给这个文件夹里的 HTML 截图（浅色、深色各一张），检查排版。
// 用法（在 studio/ 下）：node plans/userlayer/shot.mjs v-study.html [--w 1440 --h 900] [--click "选择器"]
// 截图放 studio/screenshots/userlayer/<名字>-light.png / -dark.png
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args[0];
const w = +opt("--w", 1440), h = +opt("--h", 900), click = opt("--click"), tag = opt("--tag", "");
const out = join(dir, "../../screenshots/userlayer");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "msedge" }); // 用系统的 Edge，不另装 Playwright 的浏览器
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(pathToFileURL(join(dir, file)).href);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(600);
  if (click) { await page.click(click); await page.waitForTimeout(900); }
  const name = `${basename(file, ".html")}${tag ? "-" + tag : ""}-${scheme}.png`;
  await page.screenshot({ path: join(out, name) });
  console.log(join(out, name), errors.length ? "ERRORS: " + errors.join(" | ") : "ok");
  await page.close();
}
await browser.close();
