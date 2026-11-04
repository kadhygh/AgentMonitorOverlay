import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AMO_MCP_SERVER_NAME, type McpServerSpec } from "@amo-studio/protocol";

// The person's own MCP servers as Claude Code keeps them (2026-11-04, plans/mcp.md). Studio only reads these files;
// it never writes them (HANDOFF: Studio does not change ~/.claude). Read again on every use, cached by mtime.

/** A server of the person's config, with where it came from. */
export interface LocalMcpServer {
  name: string;
  source: "user" | "local" | "project";
  spec: McpServerSpec;
  /** project (.mcp.json): whether Claude Code has it approved (enabled), turned down (disabled), or neither (null). */
  approved?: boolean | null;
}

/** The Claude Code config file of the person's own config dir: `<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json`. */
export function personClaudeConfig(dir: string, explicit: boolean): string {
  return explicit ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/** A JSON file, or null when it is missing or unreadable (a broken file must not stop a session from starting). */
function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as unknown;
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!isObj(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" || typeof x === "number").map(([k, x]) => [k, String(x)]));
  return Object.keys(out).length ? out : undefined;
};

/** An `mcpServers` entry as Claude Code writes it, or null when it is not one Studio can pass on. */
export function parseSpec(v: unknown): McpServerSpec | null {
  if (!isObj(v)) return null;
  const type = typeof v.type === "string" ? v.type : typeof v.url === "string" ? "http" : "stdio";
  if (type === "stdio") {
    if (typeof v.command !== "string" || !v.command.trim()) return null;
    const env = strMap(v.env);
    const args = strings(v.args);
    return { type: "stdio", command: v.command, ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
  }
  if (type === "http" || type === "sse") {
    if (typeof v.url !== "string" || !v.url.trim()) return null;
    const headers = strMap(v.headers);
    return { type, url: v.url, ...(headers ? { headers } : {}) };
  }
  return null;
}

function servers(v: unknown, source: LocalMcpServer["source"]): LocalMcpServer[] {
  if (!isObj(v)) return [];
  const out: LocalMcpServer[] = [];
  for (const [name, raw] of Object.entries(v)) {
    if (name === AMO_MCP_SERVER_NAME) continue;
    const spec = parseSpec(raw);
    if (spec) out.push({ name, source, spec });
  }
  return out;
}

/** Claude Code keys `projects` by the folder with forward slashes; compare without case and trailing slash. */
const folderKey = (p: string) => resolve(p).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

function projectEntry(config: unknown, folder: string): Record<string, unknown> | null {
  if (!isObj(config) || !isObj(config.projects)) return null;
  const want = folderKey(folder);
  for (const [key, entry] of Object.entries(config.projects)) if (folderKey(key) === want && isObj(entry)) return entry;
  return null;
}

/** The person's user-level servers (~/.claude.json mcpServers). */
export function userServers(configFile: string): LocalMcpServer[] {
  const config = readJson(configFile);
  return isObj(config) ? servers(config.mcpServers, "user") : [];
}

/**
 * A project's own servers: its ~/.claude.json entry (`local`) and its .mcp.json (`project`), the latter with whether
 * Claude Code approved it — in that entry or a settings file (user, project, local), as Claude Code itself reads them.
 */
export function projectServers(configFile: string, claudeDir: string, folder: string): LocalMcpServer[] {
  const entry = projectEntry(readJson(configFile), folder);
  const local = servers(entry?.mcpServers, "local");
  const file = readJson(join(folder, ".mcp.json"));
  const shared = isObj(file) ? servers(file.mcpServers, "project") : [];
  if (!shared.length) return local;
  const settings = [readJson(join(claudeDir, "settings.json")), readJson(join(folder, ".claude", "settings.json")), readJson(join(folder, ".claude", "settings.local.json")), entry];
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  let all = false;
  for (const s of settings) {
    if (!isObj(s)) continue;
    for (const n of strings(s.enabledMcpjsonServers)) enabled.add(n);
    for (const n of strings(s.disabledMcpjsonServers)) disabled.add(n);
    if (s.enableAllProjectMcpServers === true) all = true;
  }
  return [...local, ...shared.map((s) => ({ ...s, approved: disabled.has(s.name) ? false : all || enabled.has(s.name) ? true : null }))];
}

/** `${VAR}` and `${VAR:-default}` as Claude Code expands them in .mcp.json, for a server Studio passes on itself. */
export function expandVars(spec: McpServerSpec, env: NodeJS.ProcessEnv = process.env): McpServerSpec {
  const x = (s: string) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => env[name] ?? dflt ?? "");
  const map = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(v)])) : undefined);
  const env2 = map(spec.env);
  const headers = map(spec.headers);
  return {
    type: spec.type,
    ...(spec.command !== undefined ? { command: x(spec.command) } : {}),
    ...(spec.args ? { args: spec.args.map(x) } : {}),
    ...(env2 ? { env: env2 } : {}),
    ...(spec.url !== undefined ? { url: x(spec.url) } : {}),
    ...(headers ? { headers } : {}),
  };
}
