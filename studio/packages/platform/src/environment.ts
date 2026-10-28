import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeCandidates, codexOnPath, DSH_DESKTOP_ARGS, dshDesktopDir, dshDesktopIn, gitOnPath, olderVersion, versionIn } from "@amo-studio/locate";
import type { EnvironmentView, EnvItemId, EnvItemView } from "./environment-view.js";

// AMO 平台's 环境 page (the user, 2026-10-28): whether what the AMO tools run on is installed here — Claude Code, the
// DeepSeek Harness desktop app, Codex, git — and, when it is not, a link to its official page. Only looking and linking:
// nothing is downloaded, installed or changed. It is a help, not a gate: the tools still check and say for themselves,
// and work without the platform (AGENTS.md, constraint 1). It looks where Studio looks (@amo-studio/locate), so what it
// says matches 设置 → 模型 in a Studio started from here (which runs with this program's environment). Only the person's
// own Claude Code counts: a Studio installed from the platform carries no Claude Code of its own.

type Env = Record<string, string | undefined>;

/** The official pages 去下载 opens; https only, never taken from the page. */
export const DOWNLOADS: Record<EnvItemId, string | null> = {
  // Claude Code's install page (Anthropic's docs, "Advanced setup": requirements, the Windows commands, npm).
  claude: "https://code.claude.com/docs/en/setup",
  // The desktop app's page; the user, 2026-10-28 (the English page is /en/harness/, the page follows the language).
  dsh: "https://www.deepseek.com/harness/",
  // OpenAI's Codex CLI repository: its README has the Windows install and links to the docs.
  codex: "https://github.com/openai/codex",
  // Git for Windows on git-scm.com (what /download/win redirects to).
  git: "https://git-scm.com/install/windows",
};

/** Claude Code's own PowerShell install, as its docs and Studio's 设置 → 模型 give it. */
export const CLAUDE_INSTALL_COMMAND = "irm https://claude.ai/install.ps1 | iex";

const NAMES: Record<EnvItemId, string> = { claude: "Claude Code", dsh: "DeepSeek Harness 桌面版", codex: "Codex", git: "git" };
const USES: Record<EnvItemId, string> = {
  claude: "Studio 里的 Claude 订阅、GLM 等 Claude 渠道",
  dsh: "Studio 里的 DeepSeek（DSH）",
  codex: "Studio 里的 Codex / GPT 订阅",
  git: "Review、项目",
};
const ORDER: EnvItemId[] = ["claude", "dsh", "codex", "git"];

/** The page for `id`, when it is one of ours and https. */
export function downloadUrl(id: unknown): string | null {
  const url = typeof id === "string" && Object.hasOwn(DOWNLOADS, id) ? DOWNLOADS[id as EnvItemId] : null;
  return url && /^https:\/\//.test(url) ? url : null;
}

// ---- running `--version`

export type RunResult = { ok: true; out: string } | { ok: false; reason: "timeout" | "error" };
export type Runner = (file: string, args: readonly string[], options: { env: Env; timeoutMs: number }) => Promise<RunResult>;

/**
 * Starts the program and reads what it prints, giving up after `timeoutMs` (the child is killed, and the answer does not
 * wait for it to go: a .cmd's own children may hold the output open). A .cmd/.bat (npm's shims) goes through cmd.exe.
 */
export const runProgram: Runner = (file, args, { env, timeoutMs }) =>
  new Promise((done) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const script = /\.(cmd|bat)$/i.test(file);
    const childEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    let child: ReturnType<typeof spawn>;
    try {
      child = script
        ? spawn(env.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], { env: childEnv, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "ignore"] })
        : spawn(file, [...args], { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return done({ ok: false, reason: "error" });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    let out = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      if (out.length < 64 * 1024) out += d;
    });
    const answer = (code: number | null) => finish(code === 0 ? { ok: true, out } : { ok: false, reason: "error" });
    child.on("error", () => finish({ ok: false, reason: "error" }));
    // "close" comes once the output is read to the end; a child the program left running may keep it open, so the
    // answer goes a moment after "exit" at the latest.
    child.on("close", answer);
    child.on("exit", (code) => setTimeout(() => answer(code), 500).unref());
  });

// ---- the checks

export interface CheckOptions {
  env: Env;
  run?: Runner;
  /** The Claude Code version the installed Studio's SDK was built with, to tell an outdated one; null: not judged. */
  sdkClaudeCodeVersion?: string | null;
  /** Per `--version`; the DSH app gets twice this (it starts Electron as Node). */
  timeoutMs?: number;
}

const TIMEOUT_MS = 10_000;
const why = (r: { reason: "timeout" | "error" }) => (r.reason === "timeout" ? "等了太久没有回应" : "运行出错");

function item(id: EnvItemId, fields: Pick<EnvItemView, "state" | "path" | "version" | "note">): EnvItemView {
  return { id, name: NAMES[id], uses: USES[id], download: downloadUrl(id), installCommand: id === "claude" ? CLAUDE_INSTALL_COMMAND : null, ...fields };
}

/** The person's own Claude Code: the first candidate that answers `--version`, as Studio picks it. */
export async function checkClaude(o: CheckOptions): Promise<EnvItemView> {
  const run = o.run ?? runProgram;
  const candidates = claudeCodeCandidates(o.env);
  if (!candidates.length) return item("claude", { state: "missing", path: null, version: null, note: "没找到：PATH 上没有 claude，%USERPROFILE%\\.local\\bin 和 npm 的全局目录里也没有。" });
  let failure: RunResult & { ok: false } = { ok: false, reason: "error" };
  for (const exe of candidates) {
    const r = await run(exe, ["--version"], { env: o.env, timeoutMs: o.timeoutMs ?? TIMEOUT_MS });
    const version = r.ok ? versionIn(r.out) : null;
    if (version) {
      const sdk = o.sdkClaudeCodeVersion ?? null;
      if (sdk && olderVersion(version, sdk)) return item("claude", { state: "attention", path: exe, version, note: `版本比 Studio 用的 SDK（Claude Code ${sdk}）旧，有些功能可能不正常：在终端运行 claude update。` });
      return item("claude", { state: "ok", path: exe, version, note: null });
    }
    if (!r.ok) failure = r;
  }
  return item("claude", { state: "attention", path: candidates[0]!, version: null, note: `找到了，但它没有回应 claude --version（${why(failure)}），Studio 用不了它：重新装一下 Claude Code。` });
}

/** The DeepSeek Harness desktop app, where Studio looks for it; its version as Studio asks it. */
export async function checkDsh(o: CheckOptions): Promise<EnvItemView> {
  const dir = dshDesktopDir(o.env);
  const app = dir ? dshDesktopIn(dir) : null;
  const clone = "用 DSH 源码克隆的话，这一项可以不管。";
  if (!dir || !app) return item("dsh", { state: "missing", path: null, version: null, note: `没找到${dir ? `（在 ${dir} 找过）` : ""}。推荐装桌面版，它会自己更新。${clone}` });
  const r = await (o.run ?? runProgram)(app.exe, [...DSH_DESKTOP_ARGS, app.cli, "--version"], { env: { ...o.env, ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: 2 * (o.timeoutMs ?? TIMEOUT_MS) });
  const version = r.ok ? r.out.trim() || null : null;
  if (!version) return item("dsh", { state: "attention", path: app.exe, version: null, note: `装了，但问不出版本（${r.ok ? "没有输出" : why(r)}）。Studio 照样会用它；DeepSeek 会话开不起来的话，重新装一下桌面版。` });
  return item("dsh", { state: "ok", path: app.exe, version, note: null });
}

/** A program found on PATH (Codex, git) and its `--version`. */
async function checkOnPath(id: "codex" | "git", exe: string | null, o: CheckOptions): Promise<EnvItemView> {
  const command = id === "codex" ? "codex" : "git";
  if (!exe) return item(id, { state: "missing", path: null, version: null, note: `没找到：PATH 上没有 ${command}。` });
  const r = await (o.run ?? runProgram)(exe, ["--version"], { env: o.env, timeoutMs: o.timeoutMs ?? TIMEOUT_MS });
  const version = r.ok ? versionIn(r.out) : null;
  if (!version) return item(id, { state: "attention", path: exe, version: null, note: `找到了，但它没有回应 ${command} --version（${r.ok ? "看不出版本" : why(r)}）：重新装一下。` });
  return item(id, { state: "ok", path: exe, version, note: null });
}

export const checkCodex = (o: CheckOptions) => checkOnPath("codex", codexOnPath(o.env), o);
export const checkGit = (o: CheckOptions) => checkOnPath("git", gitOnPath(o.env), o);

/** All four at once (each `--version` has its own timeout, so the slowest one bounds the wait). */
export async function checkEnvironment(o: CheckOptions, now: () => Date = () => new Date()): Promise<EnvironmentView> {
  const checks: Record<EnvItemId, (o: CheckOptions) => Promise<EnvItemView>> = { claude: checkClaude, dsh: checkDsh, codex: checkCodex, git: checkGit };
  const items = await Promise.all(ORDER.map((id) => checks[id](o)));
  return { checkedAt: now().toISOString(), items };
}

/**
 * The Claude Code version an installed Studio's SDK was built with (its portable layout keeps the SDK's package.json:
 * resources/app/node_modules/@anthropic-ai/claude-agent-sdk), as Studio's own 设置 → 模型 compares against; null when
 * there is no Studio or it cannot be read.
 */
export function studioSdkClaudeCodeVersion(studioDir: string | null | undefined): string | null {
  if (!studioDir) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(studioDir, "resources", "app", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { claudeCodeVersion?: unknown };
    return typeof pkg.claudeCodeVersion === "string" ? pkg.claudeCodeVersion : null;
  } catch {
    return null;
  }
}

/** The last check, kept until 重新检测; two asks at once share one check. */
export class EnvironmentChecker {
  private last: EnvironmentView | null = null;
  private pending: Promise<EnvironmentView> | null = null;

  constructor(private readonly options: () => CheckOptions) {}

  check(fresh = false): Promise<EnvironmentView> {
    if (this.pending) return this.pending;
    if (this.last && !fresh) return Promise.resolve(this.last);
    this.pending = checkEnvironment(this.options()).then(
      (v) => {
        this.last = v;
        this.pending = null;
        return v;
      },
      (err: unknown) => {
        this.pending = null;
        throw err;
      },
    );
    return this.pending;
  }
}
