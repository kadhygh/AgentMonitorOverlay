// Does every module a packed program imports exist in its folder? (2026-11-03, plans/package-slim.md)
//   node scripts/check-package.mjs <program folder>…            e.g. "release/platform/AMO Studio"
//   node scripts/check-package.mjs <folder>… --update-allow     write what is missing now into check-package.allow.json
// package-portable.mjs runs it on every folder it builds. It reads each .js/.mjs/.cjs under resources/app and looks at the
// specifiers written out in it — `import … from "x"`, `export … from "x"`, `import "x"`, `import("x")`, `require("x")` —
// and checks that each finds a file the way Node would: a relative one a file (CommonJS also with .js/.json/.node or
// /index.js), a package name a package in some node_modules above it with its exports/main target present. Node's own
// modules and electron are skipped. Specifiers built at run time are not seen; the smoke test and e2e cover those.
// What is missing in the folders before the slimming (optional dependencies, requires in try/catch, text that only looks
// like an import) is in check-package.allow.json, per file of the program folder; anything else missing fails.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW_FILE = join(dirname(fileURLToPath(import.meta.url)), "check-package.allow.json");
const BUILTIN = new Set(builtinModules);
const SPECIFIERS = [
  /\b(?:import|export)\b[^"'`;()]*?\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*["']([^"'\n]+)["']/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** A file path, as given or completed the way CommonJS does (ESM needs it exact, but this check only asks "is it there"). */
function fileOrDir(p) {
  for (const ext of ["", ".js", ".json", ".node", ".cjs", ".mjs"]) if (isFile(p + ext)) return p + ext;
  if (existsSync(p) && statSync(p).isDirectory()) {
    const main = readJson(join(p, "package.json"))?.main;
    if (main) {
      const found = fileOrDir(join(p, main));
      if (found) return found;
    }
    for (const index of ["index.js", "index.json", "index.node"]) if (isFile(join(p, index))) return join(p, index);
  }
  return null;
}

/** The targets an exports entry can lead to (every condition: a file missing under any of them counts). */
function exportTargets(entry) {
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry)) return entry.flatMap(exportTargets);
  if (entry && typeof entry === "object") return Object.entries(entry).filter(([k]) => k !== "types" && k !== "typings" && !k.startsWith("@")).flatMap(([, v]) => exportTargets(v));
  return [];
}

function resolvePackage(pkgDir, sub) {
  const pkg = readJson(join(pkgDir, "package.json"));
  if (pkg?.exports !== undefined) {
    const exp = typeof pkg.exports === "string" || Array.isArray(pkg.exports) || !Object.keys(pkg.exports).some((k) => k.startsWith(".")) ? { ".": pkg.exports } : pkg.exports;
    const key = sub ? `./${sub}` : ".";
    let targets = exp[key] !== undefined ? exportTargets(exp[key]) : null;
    if (!targets) {
      for (const [pattern, value] of Object.entries(exp)) {
        const star = pattern.indexOf("*");
        if (star < 0) continue;
        const [before, after] = [pattern.slice(0, star), pattern.slice(star + 1)];
        if (key.startsWith(before) && key.endsWith(after) && key.length >= before.length + after.length) {
          const middle = key.slice(before.length, key.length - after.length);
          targets = exportTargets(value).map((t) => t.replaceAll("*", middle));
          break;
        }
      }
    }
    if (!targets) return { ok: false, why: `${key} 不在 exports 里` };
    const missing = targets.filter((t) => t !== null && !isFile(join(pkgDir, t)));
    return missing.length ? { ok: false, why: `exports 指向的 ${missing.join("、")} 不在` } : { ok: true };
  }
  return fileOrDir(join(pkgDir, sub || "")) ? { ok: true } : { ok: false, why: sub ? `${sub} 不在` : "main / index.js 不在" };
}

function resolveSpecifier(spec, fromFile, appDir) {
  if (spec.startsWith("node:") || BUILTIN.has(spec) || BUILTIN.has(spec.split("/")[0]) || spec === "electron" || spec.startsWith("electron/")) return { ok: true };
  if (/^[a-z]+:/i.test(spec) || spec.startsWith("/") || /^[A-Za-z]:\\/.test(spec)) return { ok: true }; // URLs, absolute paths: not ours to judge
  // A declaration file is never loaded: that is a JSDoc type (`@type {import('./list.d.ts').X}`), not an import.
  if (/\.d\.[cm]?ts$/.test(spec)) return { ok: true };
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") return fileOrDir(resolve(dirname(fromFile), spec)) ? { ok: true } : { ok: false, why: "文件不在" };
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return { ok: true }; // not a package name: text that only looks like an import
  for (let dir = dirname(fromFile); dir.startsWith(appDir); dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", name);
    if (existsSync(join(pkgDir, "package.json")) || existsSync(pkgDir)) return resolvePackage(pkgDir, sub);
    if (dir === appDir) break;
  }
  return { ok: false, why: "包不在" };
}

/** Every specifier of every script under resources/app that finds nothing: { "<path in the folder>": ["<specifier>: why", …] }. */
export function missingImports(folder) {
  const appDir = resolve(folder, "resources", "app");
  if (!existsSync(appDir)) throw new Error(`${appDir} 不在：不是打好的程序文件夹`);
  const missing = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        const specs = new Set();
        for (const re of SPECIFIERS) for (const m of text.matchAll(re)) specs.add(m[1]);
        for (const spec of [...specs].sort()) {
          const r = resolveSpecifier(spec, p, appDir);
          if (!r.ok) (missing[relative(folder, p).split(sep).join("/")] ??= []).push(`${spec}: ${r.why}`);
        }
      }
    }
  };
  walk(appDir);
  return missing;
}

const readAllow = () => readJson(ALLOW_FILE) ?? {};

/** What is missing in `folder` and not in the allow list (only the specifier counts, not why). */
export function checkPackage(folder) {
  const allow = readAllow();
  const found = missingImports(folder);
  const unexpected = [];
  for (const [file, list] of Object.entries(found)) {
    const allowed = new Set((allow[file] ?? []).map((s) => s.split(": ")[0]));
    for (const item of list) if (!allowed.has(item.split(": ")[0])) unexpected.push(`${file}: ${item}`);
  }
  return { found, unexpected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const folders = args.filter((a) => !a.startsWith("--"));
  if (!folders.length) throw new Error("用法：node scripts/check-package.mjs <程序文件夹>… [--update-allow]");
  if (args.includes("--update-allow")) {
    const allow = readAllow();
    for (const folder of folders) Object.assign(allow, missingImports(folder));
    writeFileSync(ALLOW_FILE, JSON.stringify(Object.fromEntries(Object.entries(allow).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
    console.log(`写进了 ${ALLOW_FILE}：${Object.keys(allow).length} 个文件`);
  } else {
    let failed = false;
    for (const folder of folders) {
      const { found, unexpected } = checkPackage(folder);
      const n = Object.values(found).reduce((a, l) => a + l.length, 0);
      console.log(`${folder}: 找不到的 ${n} 处，白名单以外 ${unexpected.length} 处`);
      for (const u of unexpected) console.log(`  ${u}`);
      if (unexpected.length) failed = true;
    }
    if (failed) process.exitCode = 1;
  }
}
