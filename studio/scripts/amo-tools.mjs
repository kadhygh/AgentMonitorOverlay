// The AMO tools as the release scripts know them (2026-10-28, plans/amo-lan-platform.md): one row per tool. Each tool
// has its own version (its package's package.json) and its own CHANGELOG.md beside it, one `## <version>（<date>）`
// section per release. package-portable.mjs builds a tool's program folder (release/<name>/) from its row plus its build
// details; platform-publish.mjs publishes that folder to the team server for the platform. A new tool = a row here (and
// its build details in package-portable.mjs).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * id → { name: the program folder and exe, zip: the portable zip's prefix, pkg: the package under packages/ whose
 * version and CHANGELOG.md the tool takes, description: the exe's FileDescription, platform: published to the platform }
 */
export const TOOLS = {
  studio: { name: "AMO Studio", zip: "AMO-Studio", pkg: "app", description: "AMO Studio", platform: true },
  reviewer: { name: "AMO Reviewer", zip: "AMO-Reviewer", pkg: "reviewer", description: "AMO Reviewer", platform: true },
  notes: { name: "AMO Notes", zip: "AMO-Notes", pkg: "notes", description: "AMO 便签", platform: true },
  // AMO 中转 updates itself (its service hands out the client); the platform only links to it.
  relay: { name: "AMO Relay", zip: "AMO-Relay", pkg: "relay-app", description: "AMO 中转", platform: false },
};

export function tool(id) {
  const t = TOOLS[id];
  if (!t) throw new Error(`unknown tool ${id}: ${Object.keys(TOOLS).join(", ")}`);
  return t;
}

/** The tool's version: its package's package.json. */
export function toolVersion(id, root = studio) {
  return JSON.parse(readFileSync(join(root, "packages", tool(id).pkg, "package.json"), "utf8")).version;
}

/** The section of the tool's CHANGELOG.md for `version` (its body, without the heading), or null. */
export function changelogSection(id, version, root = studio) {
  const file = join(root, "packages", tool(id).pkg, "CHANGELOG.md");
  if (!existsSync(file)) return null;
  return sectionOf(readFileSync(file, "utf8"), version);
}

/** `## 0.9.1（2026-10-29）` … up to the next `## `: the heading's version must be followed by something not part of it. */
export function sectionOf(markdown, version) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^##\\s+v?${esc}(?![0-9A-Za-z.+-])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim() || null;
}
