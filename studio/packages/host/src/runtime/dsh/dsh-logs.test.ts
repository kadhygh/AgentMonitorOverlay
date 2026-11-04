import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { pruneDshLogs, rotateLog } from "./dsh-runtime.js";

// DSH's stderr logs (2026-11-04, 架构整理第 6 步): never rotated or deleted until then.

const DAY = 24 * 60 * 60_000;
let dir: string | undefined;
afterEach(() => {
  if (dir) removeTempDir(dir);
  dir = undefined;
});

const write = (name: string, text: string, ageDays: number, now: number) => {
  const file = join(dir!, name);
  writeFileSync(file, text);
  const t = new Date(now - ageDays * DAY);
  utimesSync(file, t, t);
  return file;
};

describe("DSH logs", () => {
  it("deletes logs not written for a month and empty ones after a day; keeps the rest", () => {
    dir = mkdtempSync(join(tmpdir(), "amo-dsh-logs-"));
    const now = Date.now();
    write("s-old.log", "stderr", 31, now);
    write("s-recent.log", "stderr", 29, now);
    write("new-1.log", "", 2, now);
    write("new-2.log", "", 0.5, now);
    write("notes.txt", "", 90, now);
    expect(pruneDshLogs(dir, now)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["new-2.log", "notes.txt", "s-recent.log"]);
    expect(pruneDshLogs(join(dir, "missing"), now)).toBe(0);
  });

  it("moves a log over the limit aside when its process starts, replacing the one before", () => {
    dir = mkdtempSync(join(tmpdir(), "amo-dsh-logs-"));
    const file = join(dir, "s-a.log");
    writeFileSync(join(dir, "s-a.old.log"), "older");
    writeFileSync(file, "x".repeat(20));
    rotateLog(file, 50);
    expect(existsSync(file)).toBe(true);
    rotateLog(file, 10);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(dir, "s-a.old.log"), "utf8")).toBe("x".repeat(20));
    rotateLog(join(dir, "none.log"), 10);
  });
});
