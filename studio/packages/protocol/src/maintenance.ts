import type { Id, SessionRuntime } from "./entities.js";

// 设置 → 维护 (2026-10-20): how this Studio was started, and a terminal with a model's own CLI in the Studio repo, for
// working on Studio itself.

export interface StudioSource {
  /** The git repository Studio runs from (the folder above studio/). */
  repoRoot: string;
  branch: string | null;
  /** Short commit id of HEAD. */
  commit: string | null;
  /** Files changed and not committed (`git status --porcelain` lines). */
  changes: number;
}

/** A model whose CLI can open in a terminal: Claude Code or Codex (DSH has no terminal of its own here). */
export interface MaintenanceProfile {
  profileId: Id;
  label: string;
  runtime: SessionRuntime;
}

export interface MaintenanceInfo {
  /** "source": started from a git checkout (start-studio.cmd, npm start); "packaged": the portable build. */
  mode: "source" | "packaged";
  /** The studio/ folder (or the portable build's app folder). */
  studioRoot: string;
  source: StudioSource | null;
  profiles: MaintenanceProfile[];
}

export interface MaintenanceTerminalResult {
  /** What the terminal runs (no keys: those travel in its environment). */
  command: string;
  cwd: string;
}
