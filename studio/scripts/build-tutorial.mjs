// npm run tutorial:build — the tutorial (plans/tutorial-onboarding.md, section 5) as one self-contained HTML file.
//
// Sources in docs/tutorial/: index.md (the page's head) and ch*.md (one chapter each, in name order), the demo engine
// (engine.js), the scenes (scenes/*.js; files starting with _ are shared parts and load first), the concept map, the
// page's styles. Studio's own colour tokens come from packages/ui/src/styles/base.css, so the demos follow Studio's
// look in both themes. Everything is inlined: no CDN, no font files, no other request; it opens with a double click.
// Output: out/html/tutorial.html (git-ignored; later it goes into ui/public/).
//
// The Markdown is a small subset written here (the ui package renders Markdown to React elements, not to an HTML
// string, and never passes raw HTML): headings with {#id}, paragraphs, lists (one level of nesting), tables, quotes,
// `code`, **bold**, [links](…), and [[界面上的按钮名]] (drawn as a button; [[~x]] for words that are not Studio's,
// [[显示|核对]] when the source has only part of it). `::scene id` places a demo, `::concept-map` the concept map.
// tutorialTerms() lists every [[…]] and every label the scenes draw; scripts/tutorial-terms.test.mjs checks they are
// still in the packages' sources, so a renamed button shows up as a failing test (the tutorial needs changing too).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

export const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const tutorialDir = join(studio, "docs", "tutorial");
const outFile = join(studio, "out", "html", "tutorial.html");

const read = (file) => readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page's Markdown files: index.md first, then the chapters by name. */
export function markdownFiles(dir = tutorialDir) {
  const chapters = readdirSync(dir).filter((f) => /^ch.*\.md$/.test(f)).sort();
  return ["index.md", ...chapters].map((f) => join(dir, f));
}

/** The scripts in load order: the engine, the concept map, the shared scene parts, the scenes. */
export function scriptFiles(dir = tutorialDir) {
  const scenes = readdirSync(join(dir, "scenes"))
    .filter((f) => f.endsWith(".js"))
    .sort((a, b) => Number(!a.startsWith("_")) - Number(!b.startsWith("_")) || a.localeCompare(b))
    .map((f) => join(dir, "scenes", f));
  return [join(dir, "engine.js"), join(dir, "concept-map.js"), ...scenes];
}

/** The showcase's scripts: the engine, the shared scene parts, its own scenes (showcase/*.js). */
export function showcaseScriptFiles(dir = tutorialDir) {
  const own = readdirSync(join(dir, "showcase"))
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => join(dir, "showcase", f));
  const parts = readdirSync(join(dir, "scenes"))
    .filter((f) => f.startsWith("_") && f.endsWith(".js"))
    .sort()
    .map((f) => join(dir, "scenes", f));
  return [join(dir, "engine.js"), ...parts, ...own];
}

// ---- Markdown ------------------------------------------------------------------------------------------------------

/** Inline formatting; the same rules as the engine's T.inline for captions (plus links). */
export function inline(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\[\[~?([^\]|]+)(?:\|[^\]]*)?\]\]/g, '<span class="ui">$1</span>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

const HEADING = /^(#{1,3})\s+(.*?)(?:\s+\{#([\w-]+)\})?\s*$/;
const ITEM = /^(\s*)(?:[-*]|(\d+)\.)\s+(.*)$/;

function list(lines) {
  // [{ indent, ordered, text }] → nested <ul>/<ol> (two spaces or more of extra indent opens a child list).
  const root = { ordered: lines[0].ordered, items: [], indent: lines[0].indent };
  const stack = [root];
  for (const l of lines) {
    while (stack.length > 1 && l.indent < stack.at(-1).indent) stack.pop();
    let top = stack.at(-1);
    if (l.indent >= top.indent + 2 && top.items.length) {
      const parent = top.items.at(-1);
      parent.children = { ordered: l.ordered, items: [], indent: l.indent };
      stack.push(parent.children);
      top = parent.children;
    }
    top.items.push({ text: l.text, children: null });
  }
  const html = (node) => `<${node.ordered ? "ol" : "ul"}>${node.items.map((i) => `<li>${inline(i.text)}${i.children ? html(i.children) : ""}</li>`).join("")}</${node.ordered ? "ol" : "ul"}>`;
  return html(root);
}

function table(rows) {
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const [head, , ...body] = rows;
  const names = cells(head);
  // data-label: on a phone the rows stack and each cell says which column it is (page.css).
  return `<div class="table-wrap"><table><thead><tr>${names.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c, i) => `<td data-label="${esc(names[i] ?? "")}">${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** Markdown → HTML, and the headings (for the contents). */
export function markdown(source) {
  const lines = source.split("\n");
  const out = [];
  const headings = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(""))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    let m;
    if ((m = /^::scene\s+([\w-]+)\s*$/.exec(line))) {
      flush();
      out.push(`<figure class="demo" data-scene="${m[1]}"></figure>`);
    } else if (/^::concept-map\s*$/.test(line)) {
      flush();
      out.push('<div class="concept" data-concept></div>');
    } else if ((m = HEADING.exec(line))) {
      flush();
      const level = m[1].length;
      headings.push({ level, text: m[2], id: m[3] ?? null });
      out.push(`<h${level}${m[3] ? ` id="${m[3]}"` : ""}>${inline(m[2])}</h${level}>`);
    } else if (line.startsWith("|")) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      i--;
      out.push(table(rows));
    } else if (line.startsWith(">")) {
      flush();
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      i--;
      out.push(`<blockquote>${markdown(quote.join("\n")).html}</blockquote>`);
    } else if (ITEM.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        const it = ITEM.exec(lines[i]);
        if (it) items.push({ indent: it[1].length, ordered: it[2] !== undefined, text: it[3] });
        else items.at(-1).text += lines[i].trim(); // a wrapped item
        i++;
      }
      i--;
      out.push(list(items));
    } else if (line.startsWith("<")) {
      flush();
      const raw = [];
      while (i < lines.length && lines[i].trim()) raw.push(lines[i++]);
      i--;
      out.push(raw.join("\n"));
    } else para.push(line.trim());
  }
  flush();
  return { html: out.join("\n"), headings };
}

// ---- Studio's tokens -------------------------------------------------------------------------------------------------

/**
 * Studio's colour tokens for the demos, from base.css: the first `:root {}` (shared sizes and fonts, and the dark
 * colours) and `:root[data-theme="light"] {}`. The demos (.stage) are light unless the page is dark, as the page.
 */
export function stageTokens(css) {
  const block = (re) => {
    const m = re.exec(css);
    if (!m) throw new Error(`base.css: no ${re}`);
    return m[1]
      .split(";")
      .map((d) => d.replace(/\/\*[\s\S]*?\*\//g, "").trim())
      .filter((d) => d.startsWith("--"));
  };
  const dark = block(/:root\s*\{([^}]*)\}/);
  const light = block(/:root\[data-theme="light"\]\s*\{([^}]*)\}/);
  const names = new Set(light.map((d) => d.split(":")[0].trim()));
  const darkColours = dark.filter((d) => names.has(d.split(":")[0].trim()));
  return [
    `.stage{${[...dark, ...light].join(";")}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .stage{${darkColours.join(";")}}}`,
    `:root[data-theme="dark"] .stage{${darkColours.join(";")}}`,
  ].join("\n");
}

// ---- the scenes, read in Node (for the terms) -------------------------------------------------------------------------

/** Runs the engine, the concept map and the scenes without a document: their definitions, not the page. */
export function loadScenes(dir = tutorialDir) {
  const context = vm.createContext({ console });
  // The tutorial's scripts, then the showcase's own scenes (the engine and the parts are already loaded).
  const files = [...scriptFiles(dir), ...showcaseScriptFiles(dir).filter((f) => dirname(f) === join(dir, "showcase"))];
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
  return context.AMO_TUTORIAL;
}

/**
 * Every interface word the tutorial names: [[…]] in the Markdown, the captions and the concept map, and the labels
 * the scenes and their shared parts draw. `text` is what to look for in the sources.
 */
export function tutorialTerms(dir = tutorialDir) {
  const terms = [];
  const add = (raw, where) => {
    if (raw.startsWith("~")) return;
    const [shown, check] = raw.split("|");
    terms.push({ text: (check ?? shown).trim(), where });
  };
  const brackets = (text, where) => {
    for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) add(m[1], where);
  };
  for (const file of [...markdownFiles(dir), join(dir, "showcase.md")]) brackets(read(file), relative(studio, file));
  const T = loadScenes(dir);
  for (const def of T.scenes.values()) {
    const where = `${def.id.startsWith("sc-") ? "showcase" : "scenes"}/${def.id}.js`;
    for (const step of def.steps) if (step.say) brackets(step.say, where);
    if (def.intro) brackets(def.intro, where);
    for (const label of def.ui ?? []) add(label, where);
  }
  for (const label of T.terms) if (!terms.some((t) => t.text === label)) add(label, "scenes/_parts.js");
  for (const n of T.concept.NODES) brackets(n.text, "concept-map.js");
  return terms;
}

// ---- the page ---------------------------------------------------------------------------------------------------------

export function build({ dir = tutorialDir, out = outFile } = {}) {
  const [index, ...chapters] = markdownFiles(dir).map((file) => ({ file, ...markdown(read(file)) }));
  const toc = chapters
    .map((c) => {
      const h1 = c.headings.find((h) => h.level === 1);
      const subs = c.headings.filter((h) => h.level === 2 && h.id);
      return `<li><a href="#${h1?.id ?? ""}">${inline(h1?.text ?? "")}</a>${subs.length ? `<div class="sub">${subs.map((h) => `<a href="#${h.id}">${inline(h.text)}</a>`).join("")}</div>` : ""}</li>`;
    })
    .join("");
  const title = index.headings.find((h) => h.level === 1)?.text ?? "AMO 使用教程";
  const css = [read(join(dir, "page-base.css")), read(join(dir, "page.css")), stageTokens(read(join(studio, "packages", "ui", "src", "styles", "base.css"))), read(join(dir, "demo.css"))].join("\n");
  const scripts = [...scriptFiles(dir), join(dir, "page.js")].map((f) => `// ${relative(studio, f).replace(/\\/g, "/")}\n${read(f)}`).join("\n");
  const sources = [...markdownFiles(dir), ...scriptFiles(dir), join(dir, "page.js"), join(dir, "page-base.css"), join(dir, "page.css"), join(dir, "demo.css"), join(studio, "packages", "ui", "src", "styles", "base.css")].map((f) => `studio/${relative(studio, f).replace(/\\/g, "/")}`);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
<div class="wrap">
<nav class="top" aria-label="页面"><span class="crumb">${esc(title)}</span><button type="button" class="theme">换成深色</button></nav>
<header class="intro">
${index.html}
<nav class="toc" aria-label="目录"><b>目录</b><ol>${toc}</ol></nav>
</header>
<main>
${chapters.map((c) => `<section class="chapter">\n${c.html}\n</section>`).join("\n")}
</main>
<footer>
<p>这页由 <code>npm run tutorial:build</code>（<code>studio/scripts/build-tutorial.mjs</code>）生成，不是事实源：要改内容，改下面的源文件再重新生成。演示里的界面是照 <code>studio/packages/ui/src</code> 画的简化图，配色取自 Studio 的 token。</p>
<ul>${sources.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}</ul>
</footer>
</div>
<script>
${scripts.replace(/<\/script/gi, "<\\/script")}
</script>
</body>
</html>
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  return out;
}

// ---- the showcase (展示页) ---------------------------------------------------------------------------------------------

/**
 * showcase.md → screens: `## 标题 {#id}`, the next line the subtitle, `::scene id` (a looping demo), `::more href`
 * (「怎么用 →」), or `::cta` and a list of `- [按钮](href)`. HTML comments are notes for whoever edits it.
 */
export function showcaseScreens(source) {
  const text = source.replace(/<!--[\s\S]*?-->/g, "");
  const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? "AMO";
  const screens = text
    .split(/^##\s+/m)
    .slice(1)
    .map((block) => {
      const [head, ...rest] = block.split("\n");
      const m = HEADING.exec(`## ${head}`);
      const lines = rest.map((l) => l.trim()).filter(Boolean);
      const screen = { title: m[2], id: m[3] ?? null, sub: "", scene: null, more: null, cta: [] };
      for (const l of lines) {
        let d;
        if ((d = /^::scene\s+([\w-]+)$/.exec(l))) screen.scene = d[1];
        else if ((d = /^::more\s+(\S+)$/.exec(l))) screen.more = d[1];
        else if ((d = /^-\s+\[([^\]]+)\]\(([^)\s]+)\)$/.exec(l))) screen.cta.push({ text: d[1], href: d[2] });
        else if (!l.startsWith("::") && !screen.sub) screen.sub = l;
      }
      return screen;
    });
  return { title, screens };
}

export function buildShowcase({ dir = tutorialDir, out = join(studio, "out", "html", "showcase.html") } = {}) {
  const { title, screens } = showcaseScreens(read(join(dir, "showcase.md")));
  const base = read(join(studio, "packages", "ui", "src", "styles", "base.css"));
  const css = [stageTokens(base), read(join(dir, "demo.css")), read(join(dir, "showcase.css"))].join("\n");
  const files = [...showcaseScriptFiles(dir), join(dir, "showcase-page.js")];
  const scripts = files.map((f) => `// ${relative(studio, f).replace(/\\/g, "/")}\n${read(f)}`).join("\n");
  const sources = [join(dir, "showcase.md"), ...files, join(dir, "demo.css"), join(dir, "showcase.css"), join(studio, "packages", "ui", "src", "styles", "base.css")].map((f) => `studio/${relative(studio, f).replace(/\\/g, "/")}`);
  const body = screens
    .map((s, n) => {
      const media = s.scene
        ? `<div class="shot reveal"><figure class="demo" data-scene="${s.scene}" data-mode="loop"></figure>${s.more ? `<a class="more" href="${esc(s.more)}">怎么用 →</a>` : ""}</div>`
        : s.cta.length
          ? `<div class="cta reveal">${s.cta.map((c) => `<a href="${esc(c.href)}">${esc(c.text)}</a>`).join("")}</div>`
          : "";
      return `<section class="screen${n === 0 ? " hero" : ""}"${s.id ? ` id="${s.id}"` : ""}>
<h2 class="reveal">${inline(s.title)}</h2>
<p class="sub reveal">${inline(s.sub)}</p>
${media}
</section>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
<header class="bar"><span class="brand">AMO</span><span class="sp"></span><a class="doc" href="tutorial.html">详细教程</a><button type="button" class="theme">换成浅色</button></header>
<main>
${body}
</main>
<footer>
<p>演示内容是示意。这页由 <code>npm run tutorial:build</code>（<code>studio/scripts/build-tutorial.mjs</code>）生成，不是事实源：要改文案，改下面的源文件再重新生成。</p>
<ul>${sources.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}</ul>
</footer>
<script>
${scripts.replace(/<\/script/gi, "<\\/script")}
</script>
</body>
</html>
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`教程已生成：${build()}`);
  console.log(`展示页已生成：${buildShowcase()}`);
}
