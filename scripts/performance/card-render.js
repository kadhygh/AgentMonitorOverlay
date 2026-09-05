const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { build } = require("../../overlay/node_modules/esbuild");
const { chromium } = require(process.env.AMO_PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const artifactRoot = path.resolve(__dirname, "../../tmp/card-performance");
  const output = path.join(artifactRoot, "build");
  const mode = process.argv[2] === "baseline" ? "baseline" : "optimized";
  await build({
    entryPoints: [path.join(__dirname, "card-render.fixture.tsx")], bundle: true,
    outdir: output, entryNames: "app", platform: "browser", format: "iife", jsx: "automatic",
    nodePaths: [path.resolve(__dirname, "../../overlay/node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".png": "dataurl" }, minify: true,
  });
  const server = http.createServer((req, res) => {
    const asset = req.url.split("?")[0];
    if (asset === "/app.js" || asset === "/app.css") {
      res.setHeader("content-type", asset.endsWith("js") ? "text/javascript" : "text/css");
      res.end(fs.readFileSync(path.join(output, asset.slice(1))));
    } else {
      res.setHeader("content-type", "text/html");
      res.end('<html><head><link rel="stylesheet" href="/app.css"></head><body style="overflow:auto"><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
    const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const results = [];
    for (const count of [20, 100, 300]) {
      await page.goto(`http://127.0.0.1:${server.address().port}/?count=${count}&mode=${mode}`);
      await page.waitForFunction(() => typeof window.updateCard === "function");
      const metrics = await page.evaluate(async () => {
        const samples = [];
        for (let i = 0; i < 50; i++) {
          await new Promise(requestAnimationFrame);
          const duration = window.updateCard(i % 20);
          if (i >= 10) samples.push(duration);
        }
        samples.sort((a, b) => a - b);
        return { mountMs: window.mountMs, updateMedianMs: samples[Math.floor(samples.length / 2)],
          updateP95Ms: samples[Math.floor(samples.length * .95)], domNodes: document.querySelectorAll("*").length };
      });
      results.push({ count, ...metrics });
      if (count === 100) await page.screenshot({ path: path.join(artifactRoot, `${mode}.png`) });
    }
    console.log(JSON.stringify({ results, errors }, null, 2));
    if (errors.length) throw new Error(errors.join("; "));
    fs.writeFileSync(path.join(artifactRoot, `${mode}.json`), JSON.stringify(results, null, 2));
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
