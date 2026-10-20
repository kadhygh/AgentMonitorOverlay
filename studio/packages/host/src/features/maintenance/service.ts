import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaintenanceInfo, MaintenanceTerminalResult, StudioSource } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { git } from "../gitreview/git.js";

// src/ and dist/ sit at the same depth: studio/packages/host/{src,dist}/features/maintenance.
const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/** What the Host's own environment must not pass on: it runs as Electron's Node, and Studio's settings are its own. */
const HOST_ONLY_ENV = /^(ELECTRON_RUN_AS_NODE|AMO_STUDIO_.*)$/i;

/**
 * 设置 → 维护 (2026-10-20): whether this Studio runs from a git checkout (start-studio.cmd), and a terminal in that repo
 * with a model's own CLI (Claude Code or Codex, as 设置 → 模型 has it), to work on Studio itself.
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
      profiles: this.profiles.filter((p) => (p.runtime === "claude" || p.runtime === "codex") && !p.hidden && !p.unavailable).map((p) => ({ profileId: p.id, label: p.label, runtime: p.runtime })),
    };
  }

  async openTerminal(body: unknown): Promise<MaintenanceTerminalResult> {
    const profileId = body && typeof body === "object" ? (body as Record<string, unknown>).profileId : undefined;
    if (typeof profileId !== "string" || !profileId) throw new HostError("bad_request", "profileId is required");
    const profile = this.requireProfile(profileId);
    if (profile.runtime !== "claude" && profile.runtime !== "codex") throw new HostError("bad_request", `${profile.label} 没有能在终端里单独运行的命令行`);
    const cwd = this.repoRoot();
    if (!cwd) throw new HostError("bad_request", "这个 Studio 不是从源码启动的，没有可维护的工程");
    const launcher = this.options.launcher;
    if (!launcher) throw new HostError("bad_request", "no terminal launcher configured");
    if (!this.runtime.freshTerminal) throw new HostError("bad_request", "this Host cannot open a CLI in a terminal");
    // A missing key or login is the person's to fix in 设置 → 模型.
    const plan = await this.wrap(() => this.runtime.freshTerminal!(profileId), "bad_request");
    const env = Object.fromEntries(Object.entries({ ...process.env, ...plan.env }).filter(([k, v]) => v !== undefined && !HOST_ONLY_ENV.test(k))) as Record<string, string>;
    launcher.launch({ command: plan.command, cwd, env, envMode: "replace", title: `AMO Studio 维护 · ${profile.label}` });
    return { command: plan.command, cwd };
  }

  private async source(repoRoot: string): Promise<StudioSource> {
    const read = (args: string[]) => git(repoRoot, args).then((s) => s.trim(), () => null);
    const [branch, commit, status] = await Promise.all([read(["rev-parse", "--abbrev-ref", "HEAD"]), read(["rev-parse", "--short", "HEAD"]), read(["status", "--porcelain"])]);
    return { repoRoot, branch: branch && branch !== "HEAD" ? branch : null, commit, changes: status ? status.split("\n").filter(Boolean).length : 0 };
  }
}
