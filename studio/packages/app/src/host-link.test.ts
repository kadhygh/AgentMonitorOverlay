import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { HOST_START_FAILED } from "@amo-studio/protocol";
import { connectHost, HostStartError, keepHostAlive } from "./host-link.js";

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

describe("connectHost", () => {
  // 2026-10-28: a Host that refuses to start says why in words for the person (data of a newer Studio); the shell gets
  // that message as it is, to show it, instead of only "exited with code 4" pointing at host.log.
  it("passes on what a Host that cannot start says, as it is", async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-hostlink-"));
    const said = "这份数据（D:\\data）被更新版本的 AMO Studio 用过（数据库版本 30，这个版本只认识到 22）。请先把 Studio 更新到新版本再打开。";
    const bin = join(root, "refusing-host.mjs");
    writeFileSync(bin, `process.send({ type: ${JSON.stringify(HOST_START_FAILED)}, message: ${JSON.stringify(said)} }, () => process.exit(4));\n`);
    const err = await connectHost({ dataDir: join(root, "data"), hostBin: bin, attached: true, timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostStartError);
    expect((err as HostStartError).forPerson).toBe(said);
    expect((err as HostStartError).message).toBe(said);
  });

  it("says where the log is when a Host exits without a word", async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-hostlink-"));
    const bin = join(root, "crashing-host.mjs");
    writeFileSync(bin, "process.exit(1);\n");
    const err = await connectHost({ dataDir: join(root, "data"), hostBin: bin, attached: true, timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostStartError);
    expect((err as HostStartError).forPerson).toBeNull();
    expect((err as HostStartError).message).toMatch(/Host exited with code 1; see .*host\.log/);
  });
});
