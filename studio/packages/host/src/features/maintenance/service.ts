import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaintenanceCli, MaintenanceInfo, MaintenanceTerminalResult, StudioSource } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { git } from "../gitreview/git.js";
import { codexOnPath } from "@amo-studio/locate";
import { installedClaudeExe } from "../../runtime/claude/transcripts.js";
import { findClaudeCode } from "../../runtime/claude/executable.js";

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
 * 2026-10-28: or the person's own Codex (the one on PATH), started with the same environment as the Claude one.
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
      codex: codexExe(),
    };
  }

  async openTerminal(cli: MaintenanceCli = "claude"): Promise<MaintenanceTerminalResult> {
    const cwd = this.repoRoot();
    if (!cwd) throw new HostError("bad_request", "这个 Studio 不是从源码启动的，没有可维护的工程");
    const launcher = this.options.launcher;
    if (!launcher) throw new HostError("bad_request", "no terminal launcher configured");
    const exe = cli === "codex" ? codexExe() : claudeExe();
    if (!exe) throw new HostError("bad_request", NOT_FOUND[cli]);
    const command = `& '${exe.replace(/'/g, "''")}'`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !NOT_PASSED_ON.test(k))) as Record<string, string>;
    launcher.launch({ command, cwd, env, envMode: "replace", title: `AMO Studio 维护 · ${CLI_NAME[cli]}` });
    return { cli, command, cwd };
  }

  private async source(repoRoot: string): Promise<StudioSource> {
    const read = (args: string[]) => git(repoRoot, args).then((s) => s.trim(), () => null);
    const [branch, commit, status] = await Promise.all([read(["rev-parse", "--abbrev-ref", "HEAD"]), read(["rev-parse", "--short", "HEAD"]), read(["status", "--porcelain"])]);
    return { repoRoot, branch: branch && branch !== "HEAD" ? branch : null, commit, changes: status ? status.split("\n").filter(Boolean).length : 0 };
  }
}

const CLI_NAME: Record<MaintenanceCli, string> = { claude: "Claude Code", codex: "Codex" };

/** Said when the CLI is not there. */
const NOT_FOUND: Record<MaintenanceCli, string> = {
  claude: "没有找到 Claude Code：PATH 上没有 claude，Studio 也没有自带的那份。先在终端里装好，能直接运行 claude 后再点。",
  codex: "没有找到 Codex：PATH 上没有 codex。先在终端里装好（npm i -g @openai/codex），能直接运行 codex 后再点。",
};

/** The person's own `codex`, the first on PATH, as their terminal finds it (not the copy the Codex desktop app bundles). */
function codexExe(): string | null {
  return codexOnPath();
}

/** The person's own `claude` (it updates itself), else the one the sessions run on (the SDK's copy in a checkout). */
function claudeExe(): string | null {
  return installedClaudeExe() ?? findClaudeCode()?.path ?? null;
}
