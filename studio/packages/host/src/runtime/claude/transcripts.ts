import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { Id } from "@amo-studio/protocol";
import type { RuntimeCore } from "../runtime.js";
import { tail } from "../items.js";
import type { ClaudeHome } from "./claude-env.js";
import { describeToolUse, toolResultText } from "./tool-use.js";

// Claude Code's own transcripts of Studio's sessions (stage 16 split out of claude-runtime.ts): whether one exists,
// reading it, and importing what a terminal added while the session was handed off.

/** In-process SDK helpers (forkSession, getSessionMessages) read CLAUDE_CONFIG_DIR from this process. */
export async function withConfigDir<T>(home: ClaudeHome, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home.dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

export function readTranscript(ref: string, dir: string, home: ClaudeHome) {
  return withConfigDir(home, () => getSessionMessages(ref, { dir }));
}

export function hasTranscript(ref: string, home: ClaudeHome): boolean {
  const projects = join(home.dir, "projects");
  if (!existsSync(projects)) return false;
  return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${ref}.jsonl`)));
}

/** Turns transcript messages (written by a terminal) into items; returns how many were added. */
export function importTranscript(core: RuntimeCore, sessionId: Id, cwd: string | undefined, messages: Array<{ type: string; message: unknown }>): number {
  let added = 0;
  const tools = new Map<string, Id>();
  for (const m of messages) {
    const content = (m.message as { content?: unknown })?.content;
    const blocks: Array<Record<string, unknown>> = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (m.type === "user" && b.type === "text" && typeof b.text === "string" && !/^\s*(<[a-z-]+>|\[Request interrupted|\[Image: source:)/.test(b.text)) {
        core.appendItem(sessionId, { type: "user", text: b.text }, { method: "transcript" });
        added++;
      } else if (m.type === "user" && b.type === "tool_result") {
        const itemId = tools.get(String(b.tool_use_id));
        const detail = toolResultText(b.content);
        if (itemId) core.updateItem(itemId, (it) => (it.type === "tool" ? { ...it, status: b.is_error ? "failed" : "completed", ...(detail ? { detail: tail(detail) } : {}) } : it));
      } else if (m.type === "assistant" && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        core.appendItem(sessionId, { type: "agent", markdown: b.text, streaming: false }, { method: "transcript" });
        added++;
      } else if (m.type === "assistant" && b.type === "tool_use") {
        const created = core.appendItem(sessionId, { type: "tool", ...describeToolUse(String(b.name), (b.input ?? {}) as Record<string, unknown>, cwd), status: "completed" }, { method: "transcript", itemId: String(b.id) });
        tools.set(String(b.id), created.id);
        added++;
      }
    }
  }
  return added;
}

/** How far the transcript went when the session was handed to a terminal (kv key). */
export const handoffKey = (sessionId: Id) => `claude-handoff-seen:${sessionId}`;

/** The Claude Code executable that ships with the SDK (same version as the SDK's own processes). */
export function bundledClaudeExe(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/package.json")), "claude.exe");
}

/**
 * The person's own Claude Code, the first `claude` on PATH (native install `claude.exe`, or npm's `claude.cmd`), for
 * 设置 → 维护: it updates itself and may be newer than the SDK's. Null when there is none.
 */
export function installedClaudeExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of ["claude.exe", "claude.cmd"]) {
      const exe = join(dir, name);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}
