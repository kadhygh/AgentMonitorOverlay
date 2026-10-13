import type { FileDiff } from "@amo-studio/protocol";

// Shared shaping of runtime output into item fields (both runtimes).

/** Tool output kept on an item: its tail, which is where results and errors are. */
export const TOOL_OUTPUT_LIMIT = 20_000;
/** Arguments shown for a tool call. */
export const TOOL_INPUT_LIMIT = 8_000;
/** A file diff kept on an edit item. */
export const DIFF_LIMIT = 40_000;

export function tail(text: string, limit = TOOL_OUTPUT_LIMIT): string {
  return text.length > limit ? `…\n${text.slice(-limit)}` : text;
}

export function head(text: string, limit = TOOL_INPUT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

/** A path as shown in a row: relative to the session's folder when inside it. */
export function shortPath(path: string, cwd: string | undefined): string {
  if (!cwd || !path) return path;
  const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = norm(cwd);
  const full = norm(path);
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? full.slice(base.length + 1) : path;
}

/** Arguments as readable JSON (strings as-is). */
export function formatInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return head(value);
  const json = JSON.stringify(value, null, 2);
  return json && json !== "{}" ? head(json) : undefined;
}

/** Added and removed line counts of a unified diff (headers and hunk markers excluded). */
export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export function fileDiff(path: string, change: FileDiff["change"], diff: string | undefined): FileDiff {
  if (!diff) return { path, change, added: 0, removed: 0 };
  return { path, change, ...countDiff(diff), diff: diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n…` : diff };
}

/** A diff for text written as a whole file, or replaced in place (Claude's Write / Edit carry no diff). */
export function textDiff(before: string, after: string): string {
  const lines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").split("\n"));
  return [...lines(before).map((l) => `-${l}`), ...lines(after).map((l) => `+${l}`)].join("\n");
}

const READ = new Set(["cat", "type", "get-content", "gc", "head", "tail", "less", "more", "bat", "nl"]);
const SEARCH = new Set(["rg", "grep", "egrep", "findstr", "select-string", "sls", "ag", "ack"]);
const LIST = new Set(["ls", "dir", "get-childitem", "gci", "tree", "ll"]);

/** Splits a simple command line into words, honouring quotes. */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/**
 * The command inside a `cmd /c …` or `powershell -Command …` wrapper (the shell path may be quoted and absolute, as
 * Codex reports it), or the command itself.
 */
export function unwrapShell(command: string): string {
  const cmd = command.trim();
  const wrapped = /^(?:"[^"]*\\)?(?:cmd(?:\.exe)?"?\s+\/[cs]\s+|(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+)([\s\S]*)$/i.exec(cmd);
  return wrapped ? wrapped[1]!.trim().replace(/^(["'])([\s\S]*)\1$/, "$2") : cmd;
}

/**
 * What a shell command does, when it is one simple read, search or listing (as Codex's commandActions say on Unix;
 * on Windows they come back "unknown"). Pipelines, chains and redirects stay plain commands.
 */
export function classifyCommand(command: string): { kind: "read" | "search" | "list"; target: string } | null {
  const cmd = unwrapShell(command);
  if (!cmd || /[|;&<>`]|\$\(/.test(cmd)) return null;
  const [head, ...args] = words(cmd);
  if (!head) return null;
  const name = head.toLowerCase().replace(/\.exe$/, "");
  const plain = args.filter((a) => !a.startsWith("-") && !/^\/[a-z?]$/i.test(a));
  if (READ.has(name) && plain.length) return { kind: "read", target: plain.join(" ") };
  if (name === "sed" && args[0] === "-n" && plain.length >= 2) return { kind: "read", target: plain.at(-1)! };
  if (SEARCH.has(name) && plain.length) return { kind: "search", target: plain.join(" · ") };
  if (LIST.has(name)) return { kind: "list", target: plain[0] ?? "." };
  return null;
}

/** Text of MCP-style content blocks ([{ type: "text", text }]). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}
