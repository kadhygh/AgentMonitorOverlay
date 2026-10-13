import { useSyncExternalStore } from "react";
import { createCssVariablesTheme, createHighlighterCoreSync, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from "shiki/engine/javascript";
import langCsharp from "@shikijs/langs/csharp";
import langJson from "@shikijs/langs/json";
import langTs from "@shikijs/langs/typescript";

// Syntax highlighting (stage 12): one synchronous Shiki core with the JavaScript regex engine (no WASM) and a
// CSS-variables theme, so the colours are design tokens (`--shiki-*` in styles/base.css, light and dark). C#,
// TypeScript and JSON load up front; every other grammar loads the first time a file of its language shows, and
// callers re-render through useGrammarLoads(). The approach follows DeepSeek Harness
// (packages/client/ui-primitives/src/markdown/highlight.ts, MIT, Copyright (c) 2026 DeepSeek).

type LangModule = { default: typeof langTs };

/** Grammars loaded on demand, by grammar id. */
const LAZY = new Map<string, () => Promise<LangModule>>([
  ["javascript", () => import("@shikijs/langs/javascript")],
  ["tsx", () => import("@shikijs/langs/tsx")],
  ["jsx", () => import("@shikijs/langs/jsx")],
  ["python", () => import("@shikijs/langs/python")],
  ["c", () => import("@shikijs/langs/c")],
  ["cpp", () => import("@shikijs/langs/cpp")],
  ["java", () => import("@shikijs/langs/java")],
  ["kotlin", () => import("@shikijs/langs/kotlin")],
  ["go", () => import("@shikijs/langs/go")],
  ["rust", () => import("@shikijs/langs/rust")],
  ["lua", () => import("@shikijs/langs/lua")],
  ["shellscript", () => import("@shikijs/langs/shellscript")],
  ["powershell", () => import("@shikijs/langs/powershell")],
  ["bat", () => import("@shikijs/langs/bat")],
  ["yaml", () => import("@shikijs/langs/yaml")],
  ["toml", () => import("@shikijs/langs/toml")],
  ["ini", () => import("@shikijs/langs/ini")],
  ["markdown", () => import("@shikijs/langs/markdown")],
  ["html", () => import("@shikijs/langs/html")],
  ["css", () => import("@shikijs/langs/css")],
  ["scss", () => import("@shikijs/langs/scss")],
  ["xml", () => import("@shikijs/langs/xml")],
  ["sql", () => import("@shikijs/langs/sql")],
  ["shaderlab", () => import("@shikijs/langs/shaderlab")],
  ["hlsl", () => import("@shikijs/langs/hlsl")],
  ["glsl", () => import("@shikijs/langs/glsl")],
  ["php", () => import("@shikijs/langs/php")],
  ["ruby", () => import("@shikijs/langs/ruby")],
  ["swift", () => import("@shikijs/langs/swift")],
  ["dart", () => import("@shikijs/langs/dart")],
  ["diff", () => import("@shikijs/langs/diff")],
  ["dockerfile", () => import("@shikijs/langs/dockerfile")],
  ["vue", () => import("@shikijs/langs/vue")],
]);
const BOOT = new Set(["csharp", "json", "typescript"]);

/** File extension (lowercase, no dot) → grammar id. */
const BY_EXT: Record<string, string> = {
  cs: "csharp", csx: "csharp",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "json", json5: "json", asmdef: "json", asmref: "json", inputactions: "json",
  py: "python", pyw: "python",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", inl: "cpp",
  java: "java", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust", lua: "lua",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  bat: "bat", cmd: "bat",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", editorconfig: "ini",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html", css: "css", scss: "scss",
  xml: "xml", csproj: "xml", props: "xml", targets: "xml", xaml: "xml", uxml: "xml", svg: "xml", plist: "xml", resx: "xml",
  sql: "sql", shader: "shaderlab", cginc: "hlsl", hlsl: "hlsl", hlslinc: "hlsl", compute: "hlsl", fx: "hlsl",
  glsl: "glsl", vert: "glsl", frag: "glsl", comp: "glsl",
  php: "php", rb: "ruby", swift: "swift", dart: "dart", diff: "diff", patch: "diff", vue: "vue",
  // Unity's text assets are YAML.
  unity: "yaml", prefab: "yaml", asset: "yaml", mat: "yaml", meta: "yaml", controller: "yaml", anim: "yaml",
};
/** Whole file names → grammar id. */
const BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "shellscript", ".gitignore": "ini", ".gitattributes": "ini" };
/** Fence names in Markdown (```cs) that are not grammar ids or extensions. */
const ALIASES: Record<string, string> = {
  "c#": "csharp", csharp: "csharp", typescript: "typescript", javascript: "javascript", python: "python", shell: "shellscript",
  console: "shellscript", pwsh: "powershell", powershell: "powershell", yml: "yaml", "c++": "cpp", rust: "rust", golang: "go",
  text: "", txt: "", plaintext: "", plain: "",
};

/** The grammar for a file path, or null when there is none (shown as plain text). */
export function languageForPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? (BY_EXT[name.slice(dot + 1)] ?? null) : null;
}

/** The grammar for a Markdown fence's info string (```cs, ```ts …), or null. */
export function languageForFence(info: string): string | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!word) return null;
  if (word in ALIASES) return ALIASES[word] || null;
  if (BOOT.has(word) || LAZY.has(word)) return word;
  return BY_EXT[word] ?? null;
}

const theme = createCssVariablesTheme({ name: "css-variables", variablePrefix: "--shiki-", variableDefaults: {}, fontStyle: true });
// Patterns compile when their scanner is made, not at first match, so a line's time budget is spent on the line.
const engine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: (pattern) => defaultJavaScriptRegexConstructor(pattern, { lazyCompileLength: Number.POSITIVE_INFINITY }),
});
/** Longer lines show uncoloured: the JavaScript engine slows down badly on very long lines. */
const MAX_LINE = 1000;

let core: HighlighterCore | undefined;
const highlighter = () => (core ??= createHighlighterCoreSync({ themes: [theme], langs: [langCsharp, langJson, langTs], engine }));

const requested = new Set<string>();
const listeners = new Set<() => void>();
let loads = 0;

function ready(lang: string): boolean {
  if (BOOT.has(lang)) return true;
  if (highlighter().getLoadedLanguages().includes(lang)) return true;
  const load = LAZY.get(lang);
  if (load && !requested.has(lang)) {
    requested.add(lang);
    void load()
      .then((m) => {
        highlighter().loadLanguageSync(m.default);
        loads++;
        for (const l of listeners) l();
      })
      .catch(() => undefined);
  }
  return false;
}

/** Re-renders the caller when a grammar finishes loading (so a plain first render gets its colours). */
export function useGrammarLoads(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => loads,
  );
}

/** One coloured piece of a line. `color` is a `var(--shiki-…)` value. */
export interface CodeToken {
  text: string;
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

const plain = (code: string): CodeToken[][] => code.split("\n").map((l) => (l ? [{ text: l }] : []));

/**
 * The code's lines as coloured tokens. Highlights the whole text at once, so a comment or string spanning lines is
 * coloured right; returns null while the grammar loads (or when there is none): show plain text then.
 */
export function highlightLines(code: string, lang: string | null): CodeToken[][] | null {
  if (!lang || !ready(lang)) return null;
  try {
    const lines = code.replace(/\r\n?/g, "\n").split("\n");
    const long = lines.some((l) => l.length > MAX_LINE);
    // A very long line would stall the window: blank it for the grammar, show it plain.
    const source = long ? lines.map((l) => (l.length > MAX_LINE ? "" : l)).join("\n") : lines.join("\n");
    const { tokens } = highlighter().codeToTokens(source, { lang, theme: "css-variables", tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: 500 });
    return tokens.map((line, i) => (lines[i]!.length > MAX_LINE ? [{ text: lines[i]! }] : line.map(toToken)));
  } catch {
    return plain(code);
  }
}

function toToken(t: ThemedToken): CodeToken {
  const style = t.fontStyle ?? 0;
  return { text: t.content, ...(t.color ? { color: t.color } : {}), ...(style & 1 ? { italic: true } : {}), ...(style & 2 ? { bold: true } : {}) };
}
