// 外部打开 Review (2026-10-18): asks the AMO Studio that is open to show a project's changes in its Git Review window.
//
//   amo-review [folder] [--base REF | --commit REF [--base REF] | --range A..B | --range A...B]
//              [--mode file|changes] [--file PATH] [--line N [--end-line N]] [--session ID] [--data DIR] [--json]
//
// folder: the project (default: the current folder; registered in Studio when it is new). Without --base, --commit or
// --range: the uncommitted changes. --base REF: the working tree against REF (comments allowed). --commit REF: that
// commit, read-only (with --base, against REF). --range: B against A (A..B) or against where it left A (A...B),
// read-only. --file: the file to select first. --session: the AMO session the window is opened for. --data: Studio's
// data folder (default studio/.data, or AMO_STUDIO_DATA_DIR).
// --reviewer (2026-10-23): the AMO Reviewer program instead of Studio (any tool or model can use it; its data is in
// AMO_REVIEWER_HOME or %APPDATA%\AMO Reviewer). Started with the folder when it is not running.
// Exit codes: 0 opened, 1 refused (the message says why), 2 AMO Studio (or the Reviewer) is not running.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = { "--base": "base", "--commit": "commit", "--range": "range", "--file": "file", "--mode": "mode", "--line": "line", "--end-line": "endLine", "--session": "sessionId", "--data": "data" };

function usage(message) {
  if (message) console.error(message);
  console.error("用法：amo-review [文件夹] [--mode file|changes] [--base REF | --commit REF [--base REF] | --range A..B|A...B] [--file 路径] [--line 行号 [--end-line 行号]] [--session 会话id] [--data 数据目录] [--reviewer] [--json]");
  process.exit(message ? 1 : 0);
}

const opts = {};
let folder = null;
let json = false;
let reviewer = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") json = true;
  else if (a === "--reviewer") reviewer = true;
  else if (a === "-h" || a === "--help") usage();
  else if (a in FLAGS) {
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} 后面要跟一个值`);
    opts[FLAGS[a]] = v;
  } else if (a.startsWith("--")) usage(`不认识的参数 ${a}`);
  else if (folder === null) folder = a;
  else usage(`多了一个参数 ${a}`);
}

for (const name of ["line", "endLine"]) {
  if (opts[name] === undefined) continue;
  const n = Number(opts[name]);
  if (!Number.isSafeInteger(n) || n < 1) usage(`${name} 必须是正整数`);
  opts[name] = n;
}

const reviewerHome = resolve(process.env.AMO_REVIEWER_HOME ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "AMO Reviewer"));
const dataDir = resolve(opts.data ?? (reviewer ? join(reviewerHome, "data") : (process.env.AMO_STUDIO_DATA_DIR ?? join(studioRoot, ".data"))));
delete opts.data;
const notRunning = (why) => {
  console.error(`${reviewer ? "AMO Reviewer" : "AMO Studio"} 没有在运行（${dataDir}）：${why}`);
  process.exit(2);
};

/** The AMO Reviewer program, started with the folder (it opens it itself); not this script's child. */
function startReviewer() {
  const electron = createRequire(join(studioRoot, "package.json"))("electron");
  const main = join(studioRoot, "packages", "reviewer", "dist", "main.js");
  const argv = [main, resolve(folder ?? "."), ...Object.entries(opts).flatMap(([k, v]) => [`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(v)])];
  const env = { ...process.env, AMO_REVIEWER_HOME: reviewerHome };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(electron, argv, { env, detached: true, stdio: "ignore", windowsHide: false }).unref();
  console.log(json ? JSON.stringify({ started: true }) : "已启动 AMO Reviewer 打开它。");
  process.exit(0);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (!existsSync(join(dataDir, "host.json"))) {
  if (reviewer) startReviewer();
  notRunning("找不到 host.json");
}
if (reviewer) {
  try {
    if (!alive(JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8")).pid)) startReviewer();
  } catch {
    startReviewer();
  }
}
let info;
let token;
try {
  info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
  token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
} catch (err) {
  notRunning(err.message);
}

const body = { path: resolve(folder ?? "."), ...opts };
let res;
try {
  res = await fetch(`${info.url}/api/review/open`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
} catch (err) {
  notRunning(`连不上 Host（${err.cause?.code ?? err.message}）`);
}
const out = await res.json().catch(() => ({}));
if (!res.ok) {
  if (json) console.log(JSON.stringify(out));
  else console.error(`没有打开：${out.error?.message ?? res.status}`);
  process.exit(res.status === 409 && /窗口没有打开/.test(out.error?.message ?? "") ? 2 : 1);
}
if (json) console.log(JSON.stringify(out));
else {
  const t = out.target;
  const what = t.mode === "file" ? `文件 ${t.file}${t.line ? `:${t.line}${t.endLine ? `–${t.endLine}` : ""}` : ""}` : t.commit ? `提交 ${t.commit.slice(0, 7)}${t.base ? `（对比 ${t.base.slice(0, 7)}）` : ""}` : t.base ? `工作区对比 ${t.baseLabel ?? t.base.slice(0, 7)}` : "未提交的改动";
  console.log(`已请求 ${reviewer ? "AMO Reviewer" : "AMO Studio"} 打开 Review：${what}${out.workspaceAdded ? "（新登记了这个项目）" : ""}`);
}
