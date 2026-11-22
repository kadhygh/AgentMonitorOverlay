// No `times` on a route of the e2e tests (2026-11-23, 中转迭代讨论: 修好后补上能拦住它的测试). `page.route(…, { times: 1 })`
// takes its route off by itself once used, and a request of the page coming just then failed in Playwright
// (net::ERR_FAILED) while the page's fetch never got an answer: remote-files-mcp.spec.ts 补取 stopped on it 6 runs in 8 on
// a busy machine, on master too, put down first as a regression of 协作. e2e/support/routes.ts routeOnce keeps the route
// on and lets later requests go on (route.fallback()).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STUDIO = resolve(fileURLToPath(import.meta.url), "..", "..");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Where a `.route(` / `.routeFromHAR(` call's arguments carry `times:` — the line the call starts on. */
export function routesWithTimes(source) {
  // Comments blanked (their line breaks kept, so the lines still count): a comment may name the very thing it warns of.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
  const out = [];
  const re = /\.route(?:FromHAR)?\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // The call's arguments: up to the parenthesis that closes it (strings and template literals skipped).
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let quote = null;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    if (/\btimes\s*:/.test(text.slice(m.index, i))) out.push({ line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

describe("e2e 里的 route", () => {
  it("不用 times（用完自己撤掉时，正好进来的请求会挂住）", () => {
    const problems = [];
    for (const file of walk(join(STUDIO, "e2e"))) {
      const rel = relative(STUDIO, file).replaceAll("\\", "/");
      for (const hit of routesWithTimes(readFileSync(file, "utf8")))
        problems.push(`${rel}:${hit.line} 给 route 写了 times：用完自己撤掉的那一下，页面正好发出的请求会失败却等不到回应（补取那条因此 8 次挂 6 次）。改用 e2e/support/routes.ts 的 routeOnce`);
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("认得出带 times 的 route，跨行的也算，不把别的 times 和字符串里的算进去", () => {
    expect(routesWithTimes("await page.route((u) => u.pathname === `/a`, (r) => r.abort(), { times: 1 });")).toEqual([{ line: 1 }]);
    expect(routesWithTimes('x\nawait b.page.route(\n  (u) => u.pathname === "/b",\n  (r) => r.fulfill({ body: ")" }),\n  { times: 2 },\n);')).toEqual([{ line: 2 }]);
    expect(routesWithTimes("// `page.route(…, { times: 1 })` hangs\n\n  // again\n/* page.route(x, y,\n { times: 1 }) */\nawait page.route(\"**/c\", (r) => r.abort(), { times: 3 });")).toEqual([{ line: 6 }]);
    expect(routesWithTimes('await page.route("**/a", (r) => r.abort());\nconst o = { times: 1 };\nawait routeOnce(page, (u) => true, (r) => r.fulfill({ body: "times: 1" }));')).toEqual([]);
  });
});
