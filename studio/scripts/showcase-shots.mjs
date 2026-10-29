// npm run tutorial:shots also runs this — screenshots of out/html/showcase.html for checking the layout: every screen
// light, dark and 360 px wide (reduced motion, so each demo rests on its poster frame), a few frames taken while the
// loops really play, and each loop's length (the brief: 5–8 seconds). Output: screenshots/showcase/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { studio } from "./build-tutorial.mjs";

const page = pathToFileURL(join(studio, "out", "html", "showcase.html")).href;
const dir = join(studio, "screenshots", "showcase");
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
const problems = [];
const notes = [];
try {
  // 1. Every screen at rest.
  for (const [name, width, theme] of [
    ["dark", 1280, "dark"],
    ["light", 1280, "light"],
    ["narrow", 360, "dark"],
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 1100 : 820 }, deviceScaleFactor: width < 500 ? 2 : 1, reducedMotion: "reduce" });
    const tab = await ctx.newPage();
    tab.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
    await tab.goto(page);
    await tab.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await tab.waitForFunction(() => globalThis.AMO_TUTORIAL?.demos?.size > 0);
    const over = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) problems.push(`${name}: 页面横向多出 ${over}px`);
    const n = await tab.locator("section.screen").count();
    for (let i = 0; i < n; i++) {
      const s = tab.locator("section.screen").nth(i);
      await s.scrollIntoViewIfNeeded();
      await tab.waitForTimeout(120);
      await s.screenshot({ path: join(dir, `screen-${i + 1}-${name}.png`) });
    }
    await ctx.close();
  }

  // 2. While playing: each loop's length, and frames part way through.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const ids = [];
  {
    const t = await ctx.newPage();
    await t.goto(page);
    await t.waitForFunction(() => globalThis.AMO_TUTORIAL?.demos?.size > 0);
    ids.push(...(await t.evaluate(() => [...globalThis.AMO_TUTORIAL.demos.keys()])));
    await t.close();
  }
  await Promise.all(
    ids.map(async (id) => {
      const t = await ctx.newPage();
      t.on("pageerror", (e) => problems.push(`${id}: ${e.message}`));
      await t.goto(page);
      await t.waitForFunction(() => globalThis.AMO_TUTORIAL?.demos?.size > 0);
      // Mark each new round (the loop resets the demo at the start of every round).
      await t.evaluate((id) => {
        const d = globalThis.AMO_TUTORIAL.demos.get(id);
        globalThis.__rounds = [];
        const reset = d.reset.bind(d);
        d.reset = () => (globalThis.__rounds.push(performance.now()), reset());
      }, id);
      const fig = t.locator(`figure.demo[data-scene="${id}"]`);
      await fig.scrollIntoViewIfNeeded();
      await t.waitForTimeout(19000);
      const rounds = await t.evaluate(() => globalThis.__rounds);
      const gaps = rounds.slice(1).map((r, i) => (r - rounds[i]) / 1000);
      notes.push(`${id}: 一轮 ${gaps.map((g) => g.toFixed(1)).join(" / ") || "?"} 秒`);
      if (!gaps.length || gaps.some((g) => g < 5 || g > 8.5)) problems.push(`${id}: 一轮的长度不在 5–8 秒（${gaps.map((g) => g.toFixed(1)).join(" / ")}）`);
      // Scrolled away it stops.
      await t.evaluate(() => window.scrollTo(0, 0));
      await t.waitForTimeout(1200);
      const stopped = await t.evaluate((id) => !globalThis.AMO_TUTORIAL.demos.get(id).playing, id);
      if (!stopped && id !== "sc-board") problems.push(`${id}: 离开视口后没有停`);
      await t.close();
    }),
  );
  // Frames while really playing, one page at a time (the parallel pages above are slow); a fade still under way is
  // finished for the picture (animations: "disabled"), so a half-faded element is not mistaken for a glitch.
  for (const id of ["sc-focus", "sc-canvas", "sc-relay"]) {
    const t = await ctx.newPage();
    await t.goto(page);
    await t.waitForFunction(() => globalThis.AMO_TUTORIAL?.demos?.size > 0);
    const fig = t.locator(`figure.demo[data-scene="${id}"]`);
    await fig.scrollIntoViewIfNeeded();
    for (const ms of [1500, 3000, 4500]) {
      await t.waitForTimeout(1500);
      await fig.screenshot({ path: join(dir, `playing-${id}-${ms}ms.png`), animations: "disabled" });
    }
    await t.close();
  }
  await ctx.close();
} finally {
  await browser.close();
}
console.log(`截图在 ${dir}`);
console.log(notes.sort().join("\n"));
if (problems.length) console.log(`要看一下：\n${problems.map((p) => `- ${p}`).join("\n")}`);
