import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { HOST_START_FAILED } from "@amo-studio/protocol";
import { connectHost, HostStartError, keepHostAlive, stoppedOnPurpose } from "./host-link.js";

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

  // 2026-10-29: 完全退出 or the platform's 重启 Studio stopped the Host (POST /api/shutdown wrote host-exit.json with its
  // pid): the shell quits with it at the first missed answer instead of starting it again.
  it("does not start again a Host that was asked to stop, and says so at the first missed answer", async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-keepalive-"));
    writeFileSync(join(root, "host-exit.json"), JSON.stringify({ pid: 4242, reason: "shutdown", at: "2026-10-29T00:00:00.000Z" }));
    const lines: string[] = [];
    let restarted = 0;
    let stoppedCalls = 0;
    const stop = keepHostAlive({
      link: { dataDir: root, hostBin: join(root, "missing.js") },
      current: () => ({ url: "http://127.0.0.1:9", token: "t", child: null, pid: 4242 }),
      onRestarted: () => restarted++,
      onStopped: () => stoppedCalls++,
      log: (line) => lines.push(line),
      intervalMs: 20,
      answerMs: 200,
      isAlive: () => false,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(stoppedCalls).toBe(1);
    expect(restarted).toBe(0);
    expect(lines).toEqual(["Host was asked to stop (host-exit.json); not starting it again"]);
  });

  it("stoppedOnPurpose: only when host-exit.json names that Host", () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-keepalive-"));
    expect(stoppedOnPurpose(root, 4242)).toBe(false);
    writeFileSync(join(root, "host-exit.json"), JSON.stringify({ pid: 4242, reason: "shutdown" }));
    expect(stoppedOnPurpose(root, 4242)).toBe(true);
    // An earlier Host's mark, or a connection without a pid: a crash as before.
    expect(stoppedOnPurpose(root, 77)).toBe(false);
    expect(stoppedOnPurpose(root, undefined)).toBe(false);
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
