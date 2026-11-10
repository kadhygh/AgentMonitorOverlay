import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crashDumpsChoice, listCrashDumps, platformChannel, pruneCrashDumps, startCrashDumps } from "./crash-dumps.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "amo-crash-")));
const platform = (value: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "platform.json"), JSON.stringify(value));
};

describe("crashDumpsChoice", () => {
  it("follows the platform's channel: on for test, off for stable, off without the platform", () => {
    fresh();
    const env = { AMO_HOME: dir };
    expect(platformChannel(env)).toBeNull();
    expect(crashDumpsChoice(null, env)).toEqual({ on: false, why: "no-platform" });
    platform({ channel: "test" });
    expect(crashDumpsChoice(null, env)).toEqual({ on: true, why: "test-channel" });
    platform({ server: "http://x" });
    expect(crashDumpsChoice(null, env)).toEqual({ on: false, why: "stable-channel" });
  });

  it("the program's own setting wins over the channel, the variable over both", () => {
    fresh();
    platform({ channel: "test" });
    expect(crashDumpsChoice(false, { AMO_HOME: dir })).toEqual({ on: false, why: "setting" });
    platform({ channel: "stable" });
    expect(crashDumpsChoice(true, { AMO_HOME: dir })).toEqual({ on: true, why: "setting" });
    expect(crashDumpsChoice(true, { AMO_HOME: dir, AMO_CRASH_DUMPS: "0" })).toEqual({ on: false, why: "env" });
  });
});

describe("pruneCrashDumps", () => {
  it("keeps the newest five minidumps, in reports\\ and pending\\, and leaves other files alone", () => {
    fresh();
    const now = Date.now() / 1000;
    for (const sub of ["reports", "pending"]) mkdirSync(join(dir, sub), { recursive: true });
    for (let i = 0; i < 7; i++) {
      const p = join(dir, i % 2 ? "pending" : "reports", `d${i}.dmp`);
      writeFileSync(p, "x");
      utimesSync(p, now - i * 60, now - i * 60);
    }
    writeFileSync(join(dir, "settings.dat"), "keep");
    expect(pruneCrashDumps(dir)).toBe(2);
    expect(listCrashDumps(dir).map((d) => d.path.split(/[\\/]/).pop())).toEqual(["d0.dmp", "d1.dmp", "d2.dmp", "d3.dmp", "d4.dmp"]);
    expect(existsSync(join(dir, "settings.dat"))).toBe(true);
    expect(pruneCrashDumps(join(dir, "missing"))).toBe(0);
  });
});

describe("startCrashDumps", () => {
  it("starts Crashpad without uploading, in Electron's crashDumps folder (never moved), only when the choice is on", () => {
    fresh();
    const calls: unknown[] = [];
    const crashpad = join(dir, "Crashpad");
    const electron = { app: { getPath: (name: string) => (calls.push(["getPath", name]), crashpad) }, crashReporter: { start: (o: unknown) => calls.push(["start", o]) } };
    expect(startCrashDumps(electron, "AMO Studio", { on: false, why: "stable-channel" })).toEqual({ on: false, why: "stable-channel", dir: crashpad, started: false });
    expect(calls).toEqual([["getPath", "crashDumps"]]);
    calls.length = 0;
    expect(startCrashDumps(electron, "AMO Studio", { on: true, why: "test-channel" }).started).toBe(true);
    expect(calls).toEqual([
      ["getPath", "crashDumps"],
      ["start", { productName: "AMO Studio", uploadToServer: false, compress: false }],
    ]);
  });

  it("a test run does not start it unless AMO_CRASH_DUMPS=1, and keeps the choice to show", () => {
    fresh();
    let started = 0;
    const electron = { app: { getPath: () => dir }, crashReporter: { start: () => void started++ } };
    expect(startCrashDumps(electron, "AMO", { on: true, why: "test-channel" }, true, {})).toEqual({ on: true, why: "test-channel", dir, started: false });
    expect(startCrashDumps(electron, "AMO", { on: true, why: "env" }, true, { AMO_CRASH_DUMPS: "1" }).started).toBe(true);
    expect(started).toBe(1);
  });

  it("a reporter that throws does not stop the program", () => {
    fresh();
    const electron = { app: { getPath: () => dir }, crashReporter: { start: () => { throw new Error("no"); } } };
    expect(startCrashDumps(electron, "AMO", { on: true, why: "setting" }).started).toBe(false);
  });
});
