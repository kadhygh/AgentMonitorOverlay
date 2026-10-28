import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeCandidates, codexOnPath, dshDesktopDir, gitOnPath } from "@amo-studio/locate";
import { removeTempDir } from "@amo-studio/testkit";
import { checkClaude, checkCodex, checkDsh, checkEnvironment, checkGit, CLAUDE_INSTALL_COMMAND, DOWNLOADS, downloadUrl, EnvironmentChecker, runProgram, studioSdkClaudeCodeVersion, type RunResult, type Runner } from "./environment.js";
import { Platform } from "./platform.js";

// The 环境 page's checks against made-up machines: folders standing in for PATH, %USERPROFILE%, %APPDATA% and
// %LOCALAPPDATA%, files standing in for the exes, and a runner standing in for starting them.

let root = "";
afterEach(() => {
  if (root) removeTempDir(root);
  root = "";
});

function machine() {
  root = mkdtempSync(join(tmpdir(), "amo-env-"));
  const dirs = { bin: join(root, "bin"), empty: join(root, "empty"), home: join(root, "home"), appdata: join(root, "roaming"), local: join(root, "local") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const env = { PATH: [dirs.empty, dirs.bin].join(delimiter), USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.local };
  const file = (path: string, text = "exe") => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return { dirs, env, file };
}

/** Answers by exe path; records what was started. */
function runner(answers: Record<string, RunResult>) {
  const calls: Array<{ file: string; args: readonly string[]; env: Record<string, string | undefined>; timeoutMs: number }> = [];
  const run: Runner = async (file, args, { env, timeoutMs }) => {
    calls.push({ file, args, env, timeoutMs });
    return answers[file] ?? { ok: false, reason: "error" };
  };
  return { run, calls };
}

// Writing fresh .exe files gets them scanned by the antivirus: on a busy machine that alone passed 5 s (2026-10-28).
describe("where it looks (@amo-studio/locate, shared with the Host)", { timeout: 30_000 }, () => {
  it("Claude Code: claude on PATH, then ~/.local/bin, then npm's shim as the native exe it wraps; only what exists", () => {
    const { dirs, env, file } = machine();
    expect(claudeCodeCandidates(env)).toEqual([]);
    const npmNative = file(join(dirs.appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    file(join(dirs.appdata, "npm", "claude.cmd"), "@echo off");
    const local = file(join(dirs.home, ".local", "bin", "claude.exe"));
    const onPath = file(join(dirs.bin, "claude.exe"));
    expect(claudeCodeCandidates(env)).toEqual([onPath, local, npmNative]);
    // A shim whose package lost its exe is skipped.
    const { env: env2, dirs: d2, file: file2 } = machine();
    file2(join(d2.appdata, "npm", "claude.cmd"), "@echo off");
    expect(claudeCodeCandidates(env2)).toEqual([]);
  });

  it("Codex and git on PATH, the DSH app in %LOCALAPPDATA%\\Programs (AMO_STUDIO_DSH_DESKTOP overrides)", () => {
    const { dirs, env, file } = machine();
    expect([codexOnPath(env), gitOnPath(env)]).toEqual([null, null]);
    const codex = file(join(dirs.bin, "codex.cmd"), "@echo off");
    const git = file(join(dirs.bin, "git.exe"));
    expect([codexOnPath(env), gitOnPath(env)]).toEqual([codex, git]);
    expect(dshDesktopDir(env)).toBe(join(dirs.local, "Programs", "DeepSeek Harness"));
    expect(dshDesktopDir({ ...env, AMO_STUDIO_DSH_DESKTOP: "" })).toBeNull();
  });
});

describe("the checks", () => {
  it("Claude Code: not there, there and current, older than Studio's SDK", async () => {
    const { dirs, env, file } = machine();
    const missing = await checkClaude({ env, run: runner({}).run });
    expect(missing).toMatchObject({ id: "claude", state: "missing", path: null, version: null, installCommand: CLAUDE_INSTALL_COMMAND, download: "https://code.claude.com/docs/en/setup" });
    expect(missing.note).toContain("PATH 上没有 claude");

    const exe = file(join(dirs.home, ".local", "bin", "claude.exe"));
    const { run } = runner({ [exe]: { ok: true, out: "2.1.309 (Claude Code)\n" } });
    expect(await checkClaude({ env, run })).toMatchObject({ state: "ok", path: exe, version: "2.1.309", note: null });
    // Nothing to compare with (no Studio installed): not judged.
    expect(await checkClaude({ env, run, sdkClaudeCodeVersion: null })).toMatchObject({ state: "ok" });
    const old = await checkClaude({ env, run, sdkClaudeCodeVersion: "2.1.400" });
    expect(old).toMatchObject({ state: "attention", version: "2.1.309" });
    expect(old.note).toContain("Claude Code 2.1.400");
    expect(old.note).toContain("claude update");
  });

  it("Claude Code: a broken one on PATH does not hide a good one; none answering is 需要注意, with why", async () => {
    const { dirs, env, file } = machine();
    const broken = file(join(dirs.bin, "claude.exe"));
    const good = file(join(dirs.home, ".local", "bin", "claude.exe"));
    const r = runner({ [broken]: { ok: false, reason: "error" }, [good]: { ok: true, out: "2.1.310 (Claude Code)" } });
    expect(await checkClaude({ env, run: r.run })).toMatchObject({ state: "ok", path: good, version: "2.1.310" });
    expect(r.calls.map((c) => [c.file, c.args])).toEqual([
      [broken, ["--version"]],
      [good, ["--version"]],
    ]);

    const slow = runner({ [broken]: { ok: false, reason: "timeout" }, [good]: { ok: true, out: "no version here" } });
    const stuck = await checkClaude({ env, run: slow.run, timeoutMs: 1234 });
    expect(stuck).toMatchObject({ state: "attention", path: broken, version: null });
    expect(stuck.note).toContain("等了太久没有回应");
    expect(slow.calls.every((c) => c.timeoutMs === 1234)).toBe(true);
  });

  it("DSH desktop: not there (says where it looked), there with its version (asked as Studio asks), version not coming", async () => {
    const { dirs, env, file } = machine();
    const dir = join(dirs.local, "Programs", "DeepSeek Harness");
    const missing = await checkDsh({ env, run: runner({}).run });
    expect(missing).toMatchObject({ id: "dsh", state: "missing", download: "https://www.deepseek.com/harness/", installCommand: null });
    expect(missing.note).toContain(dir);
    // The exe alone is not the app: app.asar must be there too.
    const exe = file(join(dir, "DeepSeek Harness.exe"));
    expect((await checkDsh({ env, run: runner({}).run })).state).toBe("missing");
    file(join(dir, "resources", "app.asar"), "asar");

    const r = runner({ [exe]: { ok: true, out: "0.4.2\r\n" } });
    expect(await checkDsh({ env, run: r.run, timeoutMs: 1000 })).toMatchObject({ state: "ok", path: exe, version: "0.4.2" });
    expect(r.calls[0]!.args).toEqual(["--expose-internals", join(dir, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"), "--version"]);
    expect(r.calls[0]!.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(r.calls[0]!.timeoutMs).toBe(2000);

    const late = await checkDsh({ env, run: runner({ [exe]: { ok: false, reason: "timeout" } }).run });
    expect(late).toMatchObject({ state: "attention", path: exe, version: null });
    expect(late.note).toContain("等了太久没有回应");
  });

  it("Codex and git: not on PATH, there with a version, there without one", async () => {
    const { dirs, env, file } = machine();
    expect(await checkCodex({ env, run: runner({}).run })).toMatchObject({ id: "codex", state: "missing", download: "https://github.com/openai/codex" });
    expect(await checkGit({ env, run: runner({}).run })).toMatchObject({ id: "git", state: "missing", download: "https://git-scm.com/install/windows" });
    const codex = file(join(dirs.bin, "codex.cmd"), "@echo off");
    const git = file(join(dirs.bin, "git.exe"));
    const r = runner({ [codex]: { ok: true, out: "codex-cli 0.161.0" }, [git]: { ok: true, out: "git version 2.47.1.windows.1" } });
    expect(await checkCodex({ env, run: r.run })).toMatchObject({ state: "ok", path: codex, version: "0.161.0" });
    expect(await checkGit({ env, run: r.run })).toMatchObject({ state: "ok", path: git, version: "2.47.1" });
    const bad = await checkGit({ env, run: runner({ [git]: { ok: true, out: "huh" } }).run });
    expect(bad).toMatchObject({ state: "attention", path: git, version: null });
    expect(bad.note).toContain("git --version");
  });

  it("all four at once, in the page's order, with what each is for", async () => {
    const { env } = machine();
    const v = await checkEnvironment({ env, run: runner({}).run }, () => new Date("2026-10-28T08:00:00Z"));
    expect(v.checkedAt).toBe("2026-10-28T08:00:00.000Z");
    expect(v.items.map((i) => [i.id, i.state, i.uses])).toEqual([
      ["claude", "missing", "Studio 里的 Claude 订阅、GLM 等 Claude 渠道"],
      ["dsh", "missing", "Studio 里的 DeepSeek（DSH）"],
      ["codex", "missing", "Studio 里的 Codex / GPT 订阅"],
      ["git", "missing", "Review、项目"],
    ]);
  });

  it("keeps the last check until asked again; two asks at once share one", async () => {
    const { dirs, env, file } = machine();
    const git = file(join(dirs.bin, "git.exe"));
    let n = 0;
    const run: Runner = async (f) => (f === git ? (n++, { ok: true, out: `git version 2.0.${n}` }) : { ok: false, reason: "error" });
    const checker = new EnvironmentChecker(() => ({ env, run }));
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    expect(a).toBe(b);
    expect(n).toBe(1);
    expect(await checker.check()).toBe(a);
    const again = await checker.check(true);
    expect(again.items.find((i) => i.id === "git")!.version).toBe("2.0.2");
  });
});

describe("starting a program for its version", () => {
  it("reads a .cmd's output through cmd.exe, gives up on one that hangs, fails on one that is not a program", async () => {
    const { dirs, env, file } = machine();
    const say = file(join(dirs.bin, "say version.cmd"), "@echo off\r\necho tool 1.2.3\r\n");
    expect(await runProgram(say, ["--version"], { env: { ...process.env, ...env }, timeoutMs: 10_000 })).toEqual({ ok: true, out: expect.stringContaining("tool 1.2.3") });
    const fails = file(join(dirs.bin, "fails.cmd"), "@echo off\r\nexit /b 3\r\n");
    expect(await runProgram(fails, ["--version"], { env: { ...process.env, ...env }, timeoutMs: 10_000 })).toEqual({ ok: false, reason: "error" });
    const hangs = file(join(dirs.bin, "hangs.cmd"), "@echo off\r\n\"%SystemRoot%\\System32\\ping.exe\" -n 30 127.0.0.1 >nul\r\n"); // by full path: the test's PATH may hold only its own bin
    const started = Date.now();
    expect(await runProgram(hangs, ["--version"], { env: { ...process.env, ...env }, timeoutMs: 600 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    const notExe = file(join(dirs.bin, "not-a-program.exe"), "just text");
    expect(await runProgram(notExe, ["--version"], { env: { ...process.env, ...env }, timeoutMs: 10_000 })).toEqual({ ok: false, reason: "error" });
  }, 20_000);
});

describe("links and the platform's calls", () => {
  it("only the platform's own https pages; nothing the page makes up", () => {
    for (const url of Object.values(DOWNLOADS)) expect(url).toMatch(/^https:\/\//);
    expect(downloadUrl("git")).toBe("https://git-scm.com/install/windows");
    expect(downloadUrl("http://evil")).toBeNull();
    expect(downloadUrl("__proto__")).toBeNull();
    expect(downloadUrl(undefined)).toBeNull();
  });

  it("去下载 opens the item's page, 复制 copies the install command; the Studio SDK's Claude Code version is read from its folder", async () => {
    const { dirs } = machine();
    const opened: string[] = [];
    const copied: string[] = [];
    const platform = new Platform({
      env: { AMO_HOME: join(root, "amo"), AMO_LOCAL_HOME: join(root, "amo-local") },
      argv: [],
      version: "0.9.0",
      testMode: true,
      shell: { pickFolder: async () => null, openPath: async () => undefined, setOpenAtLogin: () => undefined, openExternal: async (u) => void opened.push(u), copyText: (t) => void copied.push(t) },
      runningPaths: async () => [],
    });
    await platform.openDownload("dsh");
    await platform.openDownload("nope");
    await platform.copyInstallCommand();
    expect(opened).toEqual(["https://www.deepseek.com/harness/"]);
    expect(copied).toEqual(["irm https://claude.ai/install.ps1 | iex"]);

    const studio = join(dirs.local, "studio");
    expect(studioSdkClaudeCodeVersion(studio)).toBeNull();
    expect(studioSdkClaudeCodeVersion(null)).toBeNull();
    const pkg = join(studio, "resources", "app", "node_modules", "@anthropic-ai", "claude-agent-sdk");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", claudeCodeVersion: "2.1.304" }));
    expect(studioSdkClaudeCodeVersion(studio)).toBe("2.1.304");
  });
});
