// 设置 → 维护 (2026-10-20): how this Studio was started, and a terminal running the person's own Claude Code in the
// Studio repo, for working on Studio itself (2026-10-21: as if they opened it themselves, no model of Studio's).
// 2026-10-28: or their own Codex, whichever of the two the person picks.

export interface StudioSource {
  /** The git repository Studio runs from (the folder above studio/). */
  repoRoot: string;
  branch: string | null;
  /** Short commit id of HEAD. */
  commit: string | null;
  /** Files changed and not committed (`git status --porcelain` lines). */
  changes: number;
}

/** Which CLI the maintenance terminal runs. */
export type MaintenanceCli = "claude" | "codex";

export interface MaintenanceInfo {
  /** "source": started from a git checkout (start-studio.cmd, npm start); "packaged": the portable build. */
  mode: "source" | "packaged";
  /** The studio/ folder (or the portable build's app folder). */
  studioRoot: string;
  source: StudioSource | null;
  /** The `claude` the terminal runs: the first on PATH, else the copy that ships with Studio's SDK; null when none. */
  claude: string | null;
  /** The `codex` the terminal runs: the first on PATH (codex.exe, or npm's codex.cmd); null when there is none. */
  codex: string | null;
}

export interface MaintenanceTerminalRequest {
  /** Default "claude". */
  cli?: MaintenanceCli;
}

export interface MaintenanceTerminalResult {
  cli: MaintenanceCli;
  /** What the terminal runs. */
  command: string;
  cwd: string;
}
