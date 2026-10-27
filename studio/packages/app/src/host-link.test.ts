import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { keepHostAlive } from "./host-link.js";

// The shell's keepalive (2026-10-27): a Host that stops answering while its process still runs is busy — logged, never
// replaced (a busy one restarted 30 s after a start cut the sessions it was resuming).

let root = "";
afterEach(() => root && removeTempDir(root));

describe("keepHostAlive", () => {
  it("leaves a Host alone that does not answer while its process runs, and says so once", async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-keepalive-"));
    const lines: string[] = [];
    let restarted = 0;
    const stop = keepHostAlive({
      link: { dataDir: root, hostBin: join(root, "missing.js") },
      // Nothing listens here: every ping fails at once.
      current: () => ({ url: "http://127.0.0.1:9", token: "t", child: null }),
      onRestarted: () => restarted++,
      log: (line) => lines.push(line),
      intervalMs: 20,
      answerMs: 200,
      isAlive: () => true,
    });
    await new Promise((r) => setTimeout(r, 400));
    stop();
    expect(restarted).toBe(0);
    expect(lines).toEqual(["Host has not answered 3 times in a row but its process runs: busy, left alone"]);
  });
});
