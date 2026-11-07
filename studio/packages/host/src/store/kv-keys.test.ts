import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KV_KEYS } from "./kv-keys.js";

// The kv table's list (kv-keys.ts) against the Host's sources: a key used that is not listed, or listed and no longer
// used, fails here. Keys are found as the features write them: a constant named …KEY… with a string, a string or a
// template's prefix handed to getKv / setKv / deleteKv, and a template's prefix in a key-making function
// (`fooKey = (id) => \`x:${id}\``) or in a local `const key = \`x:${…}\`` of a file that hands `key` to them.

const SRC = resolve(fileURLToPath(import.meta.url), "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "kv-keys.ts" ? [p] : [];
  });
}

/** Key (or prefix ending in `*`) → the files it is used in. */
function usedKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, file: string) => out.set(key, [...(out.get(key) ?? []), relative(SRC, file).replaceAll("\\", "/")]);
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b[A-Z_]*KEY[A-Z_]* = "([\w.:-]+)"/g)) add(m[1]!, file);
    for (const m of text.matchAll(/\b(?:get|set|delete)Kv\("([^"]+)"/g)) add(m[1]!, file);
    // A local `key` counts only where it goes to the kv table (Codex's notices have keys of their own).
    const localKey = /\b(?:get|set|delete)Kv\(key\b/.test(text);
    for (const line of text.split("\n")) {
      if (!/\b(?:get|set|delete)Kv\(|\w+Key = \(|const by[A-Z]\w* = \(/.test(line) && !(localKey && /\bconst key = /.test(line))) continue;
      for (const m of line.matchAll(/`([a-z][\w.:-]*[:.])\$\{/g)) add(`${m[1]}*`, file);
    }
  }
  // The prefixes kv-keys.ts itself hands out (MCP_SESSION_PREFIX…), for the files that import them.
  const own = join(SRC, "store", "kv-keys.ts");
  for (const m of readFileSync(own, "utf8").matchAll(/export const \w+_PREFIX = "([^"]+)"/g)) add(`${m[1]}*`, own);
  return out;
}

// Constants named …KEY… that are not kv keys. llm-deepseek: DSH's API-key route (DSH_KEY_PLUGIN, 2026-11-07; 自动打包
// Studio 0.9.51 stopped on it).
const NOT_KV = new Set(["DEEPSEEK_API_KEY", "deepseek-v4", "llm-deepseek"]);

describe("kv keys", () => {
  const used = usedKeys();
  for (const k of NOT_KV) used.delete(k);
  const listed = (key: string) => KV_KEYS.find((k) => (key.endsWith("*") ? k.scope !== "global" && k.key === key.slice(0, -1) : k.key === key));

  it("lists every key the Host uses", () => {
    const missing = [...used].filter(([key]) => !listed(key)).map(([key, files]) => `${key} (${files.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("lists no key the Host no longer uses, once each", () => {
    const usedNames = new Set([...used.keys()].map((k) => k.replace(/\*$/, "")));
    expect(KV_KEYS.filter((k) => !usedNames.has(k.key)).map((k) => k.key)).toEqual([]);
    expect(new Set(KV_KEYS.map((k) => k.key)).size).toBe(KV_KEYS.length);
  });
});
