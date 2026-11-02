// 把共用的样式、读写层和假数据灌进这个文件夹里每个 HTML 的标记区，HTML 仍是双击就能开的单文件。
// 用法：node studio/plans/userlayer/sync.mjs
// 标记：<style> 里 /*@amo-style*/…/*@/amo-style*/；<script id="amo-data" type="application/json">…</script>；
//       <script> 里 /*@amo-lib*/…/*@/amo-lib*/
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(homedir(), ".agents/html/claude-style.css"), "utf8");
const lib = readFileSync(join(dir, "lib.js"), "utf8");
const deckjs = readFileSync(join(dir, "vendor/deck.min.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const json = (f) => JSON.stringify(JSON.parse(readFileSync(join(dir, f), "utf8"))).replace(/<\//g, "<\\/");
// v-lanes*、v-deck* 用带 lane 的 0.2 数据（sample-lanes.json），其它用 0.1 的中转审核
const dataFor = (f) => json(/^v-(lanes|deck)/.test(f) ? "sample-lanes.json" : "sample.json");

for (const f of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
  const p = join(dir, f);
  const before = readFileSync(p, "utf8");
  const after = before
    .replace(/\/\*@amo-style\*\/[\s\S]*?\/\*@\/amo-style\*\//, () => `/*@amo-style*/\n${css}\n/*@/amo-style*/`)
    .replace(/(<script id="amo-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, a, b) => a + dataFor(f) + b)
    .replace(/\/\*@amo-lib\*\/[\s\S]*?\/\*@\/amo-lib\*\//, () => `/*@amo-lib*/\n${lib}\n/*@/amo-lib*/`)
    // 用 deck.gl 的页面在 <script> 里放 /*@deck*/…/*@/deck*/：灌 vendor/deck.min.js（约 1.2 MB，全局名 deck）
    .replace(/\/\*@deck\*\/[\s\S]*?\/\*@\/deck\*\//, () => `/*@deck*/\n${deckjs}\n/*@/deck*/`);
  if (after !== before) { writeFileSync(p, after); console.log("synced", f); }
}
