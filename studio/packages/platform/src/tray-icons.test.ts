import { describe, expect, it } from "vitest";
import { expandKnownFolder, promotionsToCarry, type TrayIconEntry } from "./tray-icons.js";

const root = "D:\\TOOLS\\AMO Platform";
let n = 0;
const entry = (exe: string, promoted: number | null, uid = "3"): TrayIconEntry => ({ key: String(++n), exe, uid, promoted });
const v = (tool: string, version: string, exe: string, promoted: number | null) => entry(`${root}\\apps\\${tool}\\${version}\\${exe}`, promoted);
const carried = (entries: TrayIconEntry[], outer: string | null = null) => promotionsToCarry(entries, root, outer).map((e) => e.exe);

describe("托盘图标: a new version keeps the icon shown in the taskbar (2026-11-06)", () => {
  it("promotes the newest version's undecided icon when the newest decided older one was shown", () => {
    // What this machine had: 0.9.22/0.9.23 never decided, 0.9.18 shown, 0.9.24 just installed.
    const entries = [v("platform", "0.9.18", "AMO Platform.exe", 1), v("platform", "0.9.22", "AMO Platform.exe", null), v("platform", "0.9.23", "AMO Platform.exe", null), v("platform", "0.9.24", "AMO Platform.exe", null)];
    expect(carried(entries)).toEqual([`${root}\\apps\\platform\\0.9.24\\AMO Platform.exe`]);
  });

  it("leaves it folded when the user folded it last, or never showed it", () => {
    expect(carried([v("studio", "0.9.30", "AMO Studio.exe", 1), v("studio", "0.9.35", "AMO Studio.exe", 0), v("studio", "0.9.42", "AMO Studio.exe", null)])).toEqual([]);
    expect(carried([v("studio", "0.9.35", "AMO Studio.exe", null), v("studio", "0.9.42", "AMO Studio.exe", null)])).toEqual([]);
  });

  it("never touches an icon the user already decided on, and compares versions as numbers", () => {
    expect(carried([v("platform", "0.9.9", "AMO Platform.exe", 1), v("platform", "0.9.10", "AMO Platform.exe", 0)])).toEqual([]);
    expect(carried([v("platform", "0.9.10", "AMO Platform.exe", 1), v("platform", "0.9.9", "AMO Platform.exe", null)])).toEqual([]);
  });

  it("keeps tools, programs and icon ids apart, and ignores programs outside the platform's folder", () => {
    const entries = [
      v("platform", "0.9.23", "AMO Platform.exe", 1),
      v("studio", "0.9.42", "AMO Studio.exe", null),
      entry(`${root}\\apps\\platform\\0.9.24\\AMO Platform.exe`, null, "4"),
      entry("G:\\PROJECT\\x\\apps\\platform\\0.9.25\\AMO Platform.exe", null),
    ];
    expect(carried(entries)).toEqual([]);
  });

  it("lets the entry <root>\\AMO Platform.exe lend its choice, and take one when it is the running newest", () => {
    const outer = entry(`${root}\\AMO Platform.exe`, 1);
    expect(carried([outer, v("platform", "0.9.24", "AMO Platform.exe", null)])).toEqual([`${root}\\apps\\platform\\0.9.24\\AMO Platform.exe`]);
    const outerNew = entry(`${root}\\AMO Platform.exe`, null);
    expect(carried([outerNew, v("platform", "0.9.24", "AMO Platform.exe", 1)], "0.9.25")).toEqual([`${root}\\AMO Platform.exe`]);
  });

  it("reads a root in Program Files, which Windows writes as a known folder's {GUID}", () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    expect(expandKnownFolder("{6D809377-6AF0-444B-8957-A3773F02200E}\\AMO\\AMO Platform.exe", env)).toBe("C:\\Program Files\\AMO\\AMO Platform.exe");
    const pf = "{6D809377-6AF0-444B-8957-A3773F02200E}\\AMO\\apps\\platform";
    const entries = [entry(`${pf}\\0.9.1\\AMO Platform.exe`, 1), entry(`${pf}\\0.9.2\\AMO Platform.exe`, null)];
    expect(promotionsToCarry(entries, "C:\\Program Files\\AMO", null, env).map((e) => e.key)).toEqual([entries[1]!.key]);
  });
});
