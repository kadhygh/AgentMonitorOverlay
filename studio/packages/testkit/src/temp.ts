import { rmSync } from "node:fs";

/**
 * Removes a test temp dir. Codex processes can hold files (sqlite, logs) for a few seconds after they are killed,
 * so retry for a while and give up quietly; a leftover dir under %TEMP% must not fail a test run.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    console.warn(`could not remove ${dir}: ${String(err)}`);
  }
}
