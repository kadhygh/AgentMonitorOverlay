import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Codex 桌面版的浏览器和电脑控制在 Studio 的 app-server 里关掉（2026-11-07，用户：「要做」）。
// 桌面版把这些工具写进共用的 ~/.codex：config.toml 里的 [mcp_servers.node_repl]，加上 openai-bundled 的几个插件（cua_repl
// 在 unified-computer-use 里）。它们要桌面版当宿主才能用：浏览器要桌面版起 app-server 时注入的 BROWSER_USE_ACCESS_*
// 变量和它签名的访问凭据（绑定会话和回合），电脑控制要连桌面版开的 \\.\pipe\codex-computer-use-<GUID>（桌面版重开就换）。
// Studio 起的 app-server 两样都没有，模型看到这些工具一用就报 "The browser access host is unavailable" / native pipe
// os error 2，每个会话还白起几个 node 进程。浏览器控制改走 设置 → MCP 加的浏览器 MCP（三家运行时都能用）。

/** Bundled plugins whose tools need the Codex desktop app as their host. Turning off one that is not there is harmless. */
export const DESKTOP_HOSTED_PLUGINS = ["browser@openai-bundled", "chrome@openai-bundled", "computer-use@openai-bundled", "unified-computer-use@openai-bundled"] as const;

/**
 * `-c` overrides for a Studio app-server that turn the desktop-hosted tools off. node_repl is turned off only when the
 * config defines it as the desktop app's (an override of an undefined MCP server makes Codex refuse the whole config).
 */
export function desktopHostedToolArgs(codexHome: string): string[] {
  const args = DESKTOP_HOSTED_PLUGINS.flatMap((id) => ["-c", `plugins.${id}.enabled=false`]);
  if (definesDesktopNodeRepl(join(codexHome, "config.toml"))) args.push("-c", "mcp_servers.node_repl.enabled=false");
  return args;
}

export function codexHomeOf(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/** Whether config.toml has a [mcp_servers.node_repl] table whose command is the desktop app's node_repl runtime. */
function definesDesktopNodeRepl(configFile: string): boolean {
  let text: string;
  try {
    if (!existsSync(configFile)) return false;
    text = readFileSync(configFile, "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*(node_repl|"node_repl")\s*\]\s*(#.*)?$/.test(l));
  if (start < 0) return false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*command\s*=\s*(.+)$/.exec(line);
    if (m) return /node_repl(\.exe)?['"]\s*$/i.test(m[1]!.trim()) && /OpenAI[\\/]+Codex/i.test(m[1]!);
  }
  return false;
}
