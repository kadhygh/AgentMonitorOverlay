import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaintenanceInfo, MaintenanceTerminalResult, StudioSource } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { git } from "../gitreview/git.js";
import { bundledClaudeExe, installedClaudeExe } from "../../runtime/claude/transcripts.js";

// src/ and dist/ sit at the same depth: studio/packages/host/{src,dist}/features/maintenance.
const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/**
 * What the Host's own environment must not pass on: it runs as Electron's Node, Studio's settings are its own, and
 * Claude's variables come from whatever started Studio. Restarted from a Claude Code session, Studio inherits that
 * session's markers (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION…): a claude started with them took itself for a child
 * session and did not save its transcript (2026-10-21). The same Studio also carries the tool shell's NO_COLOR=1,
 * COLOR=0 and TERM: the maintenance claude drew without colours, unlike one the person starts (2026-10-22). The person
 * sets none of these themselves.
 */
const NOT_PASSED_ON = /^(ELECTRON_RUN_AS_NODE|AMO_STUDIO_.*|CLAUDE.*|ANTHROPIC_.*|NO_COLOR|FORCE_COLOR|COLOR|CLICOLOR|CLICOLOR_FORCE|TERM)$/i;

/**
 * 设置 → 维护 (2026-10-20): whether this Studio runs from a git checkout (start-studio.cmd), and a terminal in that repo
 * running the person's own `claude`, to work on Studio itself. 2026-10-21, the person: just a terminal in the folder
 * with Claude Code started in it — not a model of Studio's with its endpoint, key and Studio's own settings.
 */
export class MaintenanceFeature extends Feature {
  /** The repo above studio/; the portable build's app folder has none. */
  private repoRoot(): string | null {
    const root = dirname(STUDIO_ROOT);
    return existsSync(join(root, ".git")) ? root : null;
  }

  async info(): Promise<MaintenanceInfo> {
    const repoRoot = this.repoRoot();
    return {
      mode: repoRoot ? "source" : "packaged",
      studioRoot: STUDIO_ROOT,
      source: repoRoot ? await this.source(repoRoot) : null,
      claude: claudeExe(),
    };
  }

  async openTerminal(): Promise<MaintenanceTerminalResult> {
    const cwd = this.repoRoot();
    if (!cwd) throw new HostError("bad_request", "这个 Studio 不是从源码启动的，没有可维护的工程");
    const launcher = this.options.launcher;
    if (!launcher) throw new HostError("bad_request", "no terminal launcher configured");
    const command = `& '${claudeExe().replace(/'/g, "''")}'`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !NOT_PASSED_ON.test(k))) as Record<string, string>;
    launcher.launch({ command, cwd, env, envMode: "replace", title: "AMO Studio 维护 · Claude Code" });
    return { command, cwd };
  }

  private async source(repoRoot: string): Promise<StudioSource> {
    const read = (args: string[]) => git(repoRoot, args).then((s) => s.trim(), () => null);
    const [branch, commit, status] = await Promise.all([read(["rev-parse", "--abbrev-ref", "HEAD"]), read(["rev-parse", "--short", "HEAD"]), read(["status", "--porcelain"])]);
    return { repoRoot, branch: branch && branch !== "HEAD" ? branch : null, commit, changes: status ? status.split("\n").filter(Boolean).length : 0 };
  }
}

/** The person's own `claude` (it updates itself), else the copy that ships with the SDK. */
function claudeExe(): string {
  return installedClaudeExe() ?? bundledClaudeExe();
}
