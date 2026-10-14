import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Claude Code loads a project's CLAUDE.md itself (with the settings sources on) but not AGENTS.md (CLI 2.1.296, checked
// in S12-M); Codex reads AGENTS.md. A project that keeps its instructions only in AGENTS.md gets them in Claude too.

/** Past this the rest is left out, as a CLAUDE.md that long would be too. */
const MAX_CHARS = 100_000;

/** The file in `dir` named `name` whatever its case, as Windows finds it. */
const find = (dir: string, name: string): string | undefined => {
  try {
    return readdirSync(dir).find((f) => f.toLowerCase() === name);
  } catch {
    return undefined;
  }
};
const has = (dir: string, name: string) => find(dir, name) !== undefined;

/** The project's own CLAUDE.md files, in the places Claude Code reads them from. */
function hasClaudeMd(dir: string): boolean {
  return has(dir, "claude.md") || has(dir, "claude.local.md") || has(join(dir, ".claude"), "claude.md");
}

/**
 * The text to append to Claude Code's system prompt for a project with an AGENTS.md and no CLAUDE.md, worded as Claude
 * Code words a CLAUDE.md; null when there is nothing to add.
 */
export function agentsMdInstructions(dir: string): string | null {
  if (hasClaudeMd(dir)) return null;
  const name = find(dir, "agents.md");
  if (!name) return null;
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n\n[AGENTS.md continues past ${MAX_CHARS} characters; the rest is left out]`;
  return [
    "Codebase instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
    "",
    `Contents of ${join(dir, name)} (project instructions, checked into the codebase):`,
    "",
    text.trimEnd(),
  ].join("\n");
}
