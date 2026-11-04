// npm run tutorial:shots — screenshots of out/html/tutorial.html for checking the layout (not for the tutorial
// itself): the whole page light, dark and 360 px wide, and every demo stopped at its middle step (light, dark,
// narrow). Headless, and nothing plays by itself.
// Output: screenshots/tutorial/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { studio } from "./build-tutorial.mjs";

const page = pathToFileURL(join(studio, "out", "html", "tutorial.html")).href;
const dir = join(studio, "screenshots", "tutorial");
mkdirSync(dir, { recursive: true });

// Playwright's own Chromium when it is downloaded, else the Edge every Windows has (no download needed).
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
const problems = [];
try {
  for (const [name, width, scheme] of [
    ["light", 1100, "light"],
    ["dark", 1100, "dark"],
    ["narrow", 360, "light"],
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: width < 500 ? 2 : 1, colorScheme: scheme });
    // The demos play whatever the reduced-motion setting says (engine.js): an IntersectionObserver that never fires
    // keeps them from starting on scroll.
    await ctx.addInitScript(() => {
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    });
    const tab = await ctx.newPage();
    tab.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
    await tab.goto(page);
    await tab.waitForFunction(() => globalThis.AMO_TUTORIAL?.demos?.size > 0);
    // The page must not scroll sideways.
    const over = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) problems.push(`${name}: 页面横向多出 ${over}px`);
    await tab.screenshot({ path: join(dir, `page-${name}.png`), fullPage: true });
    const concept = tab.locator(".concept").first();
    await concept.scrollIntoViewIfNeeded();
    await concept.screenshot({ path: join(dir, `concept-${name}.png`) });
    await tab.locator("header.intro").screenshot({ path: join(dir, `intro-${name}.png`) });
    const tables = tab.locator(".table-wrap");
    for (let n = 0; n < (await tables.count()); n++) await tables.nth(n).screenshot({ path: join(dir, `table-${n + 1}-${name}.png`) });
    const ids = await tab.evaluate(() => [...globalThis.AMO_TUTORIAL.demos.keys()]);
    for (const id of ids) {
      // Every step: elements that run out of the demo's area (it clips them, so look at the elements' boxes).
      const clipped = await tab.evaluate(async (id) => {
        const d = globalThis.AMO_TUTORIAL.demos.get(id);
        const out = [];
        for (let n = 0; n < d.def.steps.length; n++) {
          await d.goto(n, { instant: true });
          const s = d.stage.getBoundingClientRect();
          const over = [...d.stage.querySelectorAll("[data-k]")]
            .filter((el) => el.getClientRects().length && el.getBoundingClientRect().width > 0)
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.right > s.right + 1 || r.bottom > s.bottom + 1;
            })
            .map((el) => el.dataset.k);
          if (over.length) out.push(`第 ${n + 1} 步：${over.join("、")}`);
        }
        await d.goto(Math.floor((d.def.steps.length - 1) / 2), { instant: true });
        return out;
      }, id);
      for (const c of clipped) problems.push(`${name} · ${id} ${c} 超出演示区域`);
      const fig = tab.locator(`figure.demo[data-scene="${id}"]`);
      await fig.scrollIntoViewIfNeeded();
      await fig.screenshot({ path: join(dir, `demo-${id}-${name}.png`) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`截图在 ${dir}`);
if (problems.length) console.log(`要看一下：\n${problems.map((p) => `- ${p}`).join("\n")}`);
