import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_HOSTED_PLUGINS, desktopHostedToolArgs } from "./desktop-tools.js";

const dirs: string[] = [];
function home(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "amo-codex-home-"));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, "config.toml"), config);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pluginArgs = DESKTOP_HOSTED_PLUGINS.flatMap((id) => ["-c", `plugins.${id}.enabled=false`]);

describe("desktopHostedToolArgs", () => {
  it("turns the desktop app's plugins off even without a config", () => {
    expect(desktopHostedToolArgs(home())).toEqual(pluginArgs);
  });

  it("turns node_repl off when it is the desktop app's", () => {
    const config = [
      'model = "x"',
      "[mcp_servers.node_repl]",
      "args = []",
      "command = 'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\9c26\\bin\\node_repl.exe'",
      "[mcp_servers.node_repl.env]",
      'SKY_CUA_NATIVE_PIPE = "1"',
    ].join("\r\n");
    expect(desktopHostedToolArgs(home(config))).toEqual([...pluginArgs, "-c", "mcp_servers.node_repl.enabled=false"]);
  });

  it("leaves a node_repl of the person's own, or none, alone (an override of an undefined server breaks the config)", () => {
    expect(desktopHostedToolArgs(home('[mcp_servers.node_repl]\ncommand = "C:/tools/my-repl.exe"\n'))).toEqual(pluginArgs);
    expect(desktopHostedToolArgs(home('[mcp_servers.other]\ncommand = "node_repl.exe"\n'))).toEqual(pluginArgs);
  });
});
