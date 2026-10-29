import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { build, buildShowcase, inline, markdown, showcaseScreens, stageTokens, studio, tutorialDir, tutorialTerms } from "./build-tutorial.mjs";

// The tutorial names Studio's buttons, menus and pages (plans/tutorial-onboarding.md, section 5: the cheap check
// against drift). Each must still be written in the packages' sources; when one is renamed this fails — change the
// tutorial (docs/tutorial/) along with the interface. Comments do not count, tests neither.

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|cts|mts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const packages = join(studio, "packages");
const corpus = readdirSync(packages)
  .map((p) => join(packages, p, "src"))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap((d) => sources(d))
  .map((f) => ({ file: relative(studio, f), text: stripComments(readFileSync(f, "utf8")) }));

describe("tutorial", () => {
  const terms = tutorialTerms();

  it("names interface words", () => {
    expect(terms.length).toBeGreaterThan(80);
  });

  it("names only words still in the sources", () => {
    const missing = [...new Map(terms.map((t) => [t.text, t])).values()].filter((t) => !corpus.some((f) => f.text.includes(t.text)));
    expect(missing.map((t) => `「${t.text}」（${t.where}）`)).toEqual([]);
  });

  it("renders its Markdown subset", () => {
    const { html, headings } = markdown("# 标题 {#a}\n\n一段 **粗** 和 `代码`，点 [[+ 新任务]]、[[~暂停]]、[[‹ 看板|看板]]。\n\n- 一\n  - 一.一\n- 二\n\n| 列 | 值 |\n|---|---|\n| a | b |\n\n> 注意\n\n::scene x\n");
    expect(headings).toEqual([{ level: 1, text: "标题", id: "a" }]);
    expect(html).toContain('<h1 id="a">标题</h1>');
    expect(html).toContain('<strong>粗</strong> 和 <code>代码</code>');
    expect(html).toContain('<span class="ui">+ 新任务</span>、<span class="ui">暂停</span>、<span class="ui">‹ 看板</span>');
    expect(html).toContain("<ul><li>一<ul><li>一.一</li></ul></li><li>二</li></ul>");
    expect(html).toContain("<th>列</th>");
    expect(html).toContain("<blockquote><p>注意</p></blockquote>");
    expect(html).toContain('<figure class="demo" data-scene="x"></figure>');
    expect(inline("<b>")).toBe("&lt;b&gt;");
  });

  it("takes both of Studio's themes for the demos", () => {
    const css = stageTokens(':root {\n  --fs: 12px;\n  --bg: #111;\n  color-scheme: dark;\n}\n:root[data-theme="light"] {\n  --bg: #eee;\n}');
    expect(css).toContain(".stage{--fs: 12px;--bg: #111;--bg: #eee}");
    expect(css).toContain(':root[data-theme="dark"] .stage{--bg: #111}');
  });

  it("keeps the showcase short: a title of at most 10, a subtitle of at most 20 (a Latin word counts one)", () => {
    const { screens } = showcaseScreens(readFileSync(join(tutorialDir, "showcase.md"), "utf8"));
    const len = (s) => s.replace(/[A-Za-z0-9_.]+/g, "a").replace(/\s/g, "").length;
    expect(screens.length).toBeGreaterThanOrEqual(7);
    for (const s of screens) {
      expect(len(s.title), s.title).toBeLessThanOrEqual(10);
      expect(len(s.sub), s.sub).toBeLessThanOrEqual(20);
      expect(!!s.scene || s.cta.length > 0, s.title).toBe(true);
    }
    const dir = mkdtempSync(join(tmpdir(), "amo-showcase-"));
    const html = readFileSync(buildShowcase({ out: join(dir, "showcase.html") }), "utf8");
    rmSync(dir, { recursive: true, force: true });
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/i);
    for (const m of html.matchAll(/data-scene="([\w-]+)"/g)) expect(html).toContain(`id: "${m[1]}"`);
  });

  it("builds one file with nothing from outside", () => {
    const dir = mkdtempSync(join(tmpdir(), "amo-tutorial-"));
    const html = readFileSync(build({ out: join(dir, "tutorial.html") }), "utf8");
    rmSync(dir, { recursive: true, force: true });
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/i);
    // Every demo placed in the text has a scene.
    for (const m of html.matchAll(/data-scene="([\w-]+)"/g)) expect(html).toContain(`id: "${m[1]}"`);
  });
});
