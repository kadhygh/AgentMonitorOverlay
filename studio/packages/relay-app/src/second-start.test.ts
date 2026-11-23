import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { argvText, KNOCK, knockAction, Knocks, sameProgram, secondStartPlan, WindowLog } from "./second-start.js";

// A second start of the client (2026-11-23, 「× 关不上又弹出来」): who stays, who waits, a repeated knock shown once.

const REAL = "D:/TOOLS/AMO Platform/apps/relay/0.9.12/AMO Relay.exe";
const CURRENT = "D:/TOOLS/AMO Platform/apps/relay/current/AMO Relay.exe";
const NEWER = "D:/TOOLS/AMO Platform/apps/relay/0.9.13/AMO Relay.exe";
/** `current` is a junction to 0.9.12. */
const real = (p: string) => (p === CURRENT ? REAL : p);
const alive = (pid: number) => pid === 4242;

describe("sameProgram", () => {
  it("the same file by any path or case", () => {
    expect(sameProgram(CURRENT, REAL, real)).toBe(true);
    expect(sameProgram(REAL.toUpperCase(), REAL, real)).toBe(true);
    expect(sameProgram(NEWER, REAL, real)).toBe(false);
  });
});

describe("knockAction: the running client", () => {
  it("gives way only to another program, without --open", () => {
    expect(knockAction(["x", "--server", "http://s"], NEWER, REAL, real)).toBe("quit");
    expect(knockAction(["x", "--open=cowork:t_1"], NEWER, REAL, real)).toBe("show");
  });
  it("shows itself for its own exe by any path (the platform's real folder, Studio's current)", () => {
    expect(knockAction(["x"], REAL, REAL, real)).toBe("show");
    expect(knockAction(["x"], CURRENT, REAL, real)).toBe("show");
    expect(knockAction(["x"], undefined, REAL, real)).toBe("show");
  });
  it("quits for --amo-quit", () => {
    expect(knockAction(["x", "--amo-quit"], REAL, REAL, real)).toBe("quit");
  });
});

describe("secondStartPlan: the second start", () => {
  const running = (exe: string, more: Record<string, unknown> = {}) => ({ pid: 4242, exe, open: ["cowork", "thread"], ...more });
  it("done when the running one is the same exe — it does not try again every 500 ms", () => {
    expect(secondStartPlan(["x"], REAL, running(REAL), alive, real).plan).toBe("done");
    // also one from before knock: it stays for its own path too
    expect(secondStartPlan(["x"], REAL, { pid: 4242, exe: REAL }, alive, real).plan).toBe("done");
  });
  it("another path to it: done when the running one says knock, else wait (an older one gives way)", () => {
    expect(secondStartPlan(["x"], REAL, running(CURRENT, { knock: KNOCK }), alive, real).plan).toBe("done");
    expect(secondStartPlan(["x"], REAL, running(CURRENT), alive, real).plan).toBe("wait");
  });
  it("another program: wait for the lock (it gives way), unless it opens what was asked", () => {
    expect(secondStartPlan(["x"], NEWER, running(REAL, { knock: KNOCK }), alive, real).plan).toBe("wait");
    expect(secondStartPlan(["x", "--open=cowork:t_1"], NEWER, running(REAL, { knock: KNOCK }), alive, real).plan).toBe("done");
  });
  it("nothing says which one runs: wait, as before", () => {
    expect(secondStartPlan(["x"], REAL, null, alive, real).plan).toBe("wait");
    expect(secondStartPlan(["x"], REAL, { pid: 77, exe: REAL, knock: KNOCK }, alive, real).plan).toBe("wait");
  });
});

describe("Knocks", () => {
  it("the same start knocking again within a few seconds is a repeat; another start is not", () => {
    const k = new Knocks();
    const a = ["AMO Relay.exe", "--original-process-start-time=1"];
    expect(k.repeat(a, REAL, 0)).toBe(false);
    expect(k.repeat(a, REAL, 500)).toBe(true);
    expect(k.repeat(a, REAL, 8500 - 500)).toBe(false); // a gap of 7.5 s: not one run of tries
    expect(k.repeat(["AMO Relay.exe", "--original-process-start-time=2"], REAL, 8100)).toBe(false);
  });
});

describe("WindowLog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it("appends a line per event and moves a big log aside", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-window-log-"));
    dirs.push(dir);
    const file = join(dir, "window.log");
    const log = new WindowLog(file);
    log.write("show: tray click");
    log.write("hidden (×)\nsecond line");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT.* \[\d+\] show: tray click$/);
    expect(lines[1]).toMatch(/hidden \(×\) second line$/);
    writeFileSync(file, "x".repeat(WindowLog.LOG_MAX + 1));
    log.write("after");
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThan(200);
  });
  it("argvText leaves Chromium's switches out and keeps it short", () => {
    expect(argvText(["exe", "--server", "http://s", "--allow-file-access-from-files", "--original-process-start-time=13"])).toBe('["--server","http://s"]');
    expect(argvText(["exe", "a".repeat(500)]).length).toBeLessThan(410);
  });
});
