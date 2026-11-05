import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { OutsideSession, OutsideSessionPreview, Workspace } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import type { ClaudeHome } from "./claude-env.js";
import { withConfigDir } from "./transcripts.js";

// 接续已有会话 (2026-11-05, plans/done/resume-cli-sessions.md): Claude sessions started outside Studio — a terminal's `claude`,
// the Claude desktop app — listed so a new task can go on from one. They live where Studio's local-login sessions do
// (the person's config dir; added accounts link its `projects`), so the SDK's own session helpers read them.

/** The original sessions already taken on (kv key; the value is the Studio session that went on from its copy). */
export const adoptedKey = (ref: string) => `claude-adopted:${ref}`;

/** What Claude Code writes first when a conversation goes on after a compaction (its summary, not the person's words). */
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/;

/** Turns of the end of a conversation shown to recognise it. */
const PREVIEW_MESSAGES = 6;
const PREVIEW_CHARS = 600;

/**
 * The outside sessions: SDK-started ones left out as the terminal's /resume does (`includeProgrammatic: false`, which
 * leaves out Studio's own, entrypoint sdk-ts), then those Studio has (any of its sessions' runtimeRef, archived too) and
 * the originals already taken on.
 */
export async function listOutsideSessions(home: ClaudeHome, store: Store, workspaces: readonly Workspace[]): Promise<OutsideSession[]> {
  const known = new Set(store.listSessions().flatMap((s) => (s.runtime === "claude" && s.runtimeRef ? [s.runtimeRef] : [])));
  const found = await withConfigDir(home, () => listSessions({ includeProgrammatic: false }));
  const files = transcriptFiles(home.dir);
  const live = workspaces.filter((w) => !w.archivedAt && !w.builtin);
  return found
    .filter((s) => !known.has(s.sessionId) && !store.getKv(adoptedKey(s.sessionId)) && !!s.cwd)
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((s) => {
      const file = files.get(s.sessionId);
      return {
        id: s.sessionId,
        title: (s.customTitle || s.summary || s.firstPrompt || "").trim().slice(0, 200) || "（没有标题）",
        ...(s.firstPrompt ? { firstPrompt: s.firstPrompt.slice(0, 300) } : {}),
        cwd: s.cwd!,
        workspaceId: projectOf(s.cwd!, live)?.id ?? null,
        source: file ? sourceOf(file) : "other",
        lastModified: new Date(s.lastModified).toISOString(),
        ...(s.createdAt ? { createdAt: new Date(s.createdAt).toISOString() } : {}),
        ...(s.fileSize !== undefined ? { bytes: s.fileSize } : {}),
        ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
      };
    });
}

/** The end of a session's conversation, as it would be imported (since its last compaction). */
export async function previewOutsideSession(home: ClaudeHome, ref: string): Promise<OutsideSessionPreview | null> {
  const messages = await withConfigDir(home, () => getSessionMessages(ref));
  if (!messages.length) return null;
  const texts = messages.flatMap((m) => {
    if (m.type !== "user" && m.type !== "assistant") return [];
    const text = messageText(m.message);
    return text ? [{ role: m.type, text }] : [];
  });
  const compacted = texts.some((t) => t.role === "user" && COMPACT_SUMMARY.test(t.text));
  const shown = texts.filter((t) => !(t.role === "user" && COMPACT_SUMMARY.test(t.text))).slice(-PREVIEW_MESSAGES);
  return {
    messages: shown.map((t) => ({ role: t.role, text: t.text.length > PREVIEW_CHARS ? `${t.text.slice(0, PREVIEW_CHARS)}…` : t.text })),
    total: messages.filter((m) => m.type === "user" || m.type === "assistant").length,
    compacted,
  };
}

/** Whether the first message of a conversation is Claude Code's compaction summary (it is not imported). */
export function isCompactSummary(message: { type: string; message: unknown }): boolean {
  return message.type === "user" && COMPACT_SUMMARY.test(messageText(message.message));
}

/**
 * The person's words or the reply's text: string content or its text blocks, without tool results and the CLI's own
 * wrapped lines (`<command-name>`, `<local-command-stdout>`, `<system-reminder>`…).
 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  const blocks: Array<Record<string, unknown>> = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string" && !/^\s*(<[a-z-]+>|\[Request interrupted|\[Image: source:)/.test(b.text))
    .map((b) => String(b.text).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The project a folder belongs to: the one whose folder it is, or the deepest one holding it. */
export function projectOf(cwd: string, workspaces: readonly Workspace[]): Workspace | undefined {
  const dir = normDir(cwd);
  let best: Workspace | undefined;
  for (const w of workspaces) {
    const root = normDir(w.path);
    if ((dir === root || dir.startsWith(root + "/")) && (!best || root.length > normDir(best.path).length)) best = w;
  }
  return best;
}

/** Same folder whatever the case and slashes (as on Windows). */
export function sameFolder(a: string, b: string): boolean {
  return normDir(a) === normDir(b);
}

function normDir(p: string): string {
  return resolvePath(p).split(sep).join("/").replace(/\/+$/, "").toLowerCase();
}

/** Every transcript under the config dir's `projects`, by session id. */
function transcriptFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const projects = join(dir, "projects");
  if (!existsSync(projects)) return out;
  for (const d of readdirSync(projects, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      for (const f of readdirSync(join(projects, d.name))) if (f.endsWith(".jsonl")) out.set(f.slice(0, -6), join(projects, d.name, f));
    } catch {
      // A folder that cannot be read is left out.
    }
  }
  return out;
}

/**
 * Where the session was started, from the first `entrypoint` in its transcript: `cli` a terminal, `claude-desktop`
 * (`-3p`) the Claude desktop app (the values are Claude Code's own; the desktop one read from its binary, 2026-11-05).
 */
export function sourceOf(file: string): OutsideSession["source"] {
  const head = readHead(file, 64 * 1024);
  const entry = /"entrypoint":"([^"]+)"/.exec(head)?.[1];
  if (entry === "cli") return "cli";
  if (entry === "claude-desktop" || entry === "claude-desktop-3p") return "desktop";
  return "other";
}

function readHead(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
