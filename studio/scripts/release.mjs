// One way to release (2026-10-31, plans/release.md): the platform's tools and AMO 中转's service, from master only.
//   npm run release -- status                       per tool: version here, last release (tag), what changed since, 「下一版」
//                                                   entries; then both platform channels (relay-mac platform-status)
//   npm run release -- due [--wait <min>]           what is waiting to go out — tools changed since their tag with 「下一版」
//                                                   entries — one line each, nothing when nothing is (值守's check uses it);
//                                                   --wait: only once the oldest such change is that old
//   npm run release -- <tool…> | auto [--minor] [--skip-tests] [--dry-run]
//                                                   checks, typecheck + unit tests, version +1, 「下一版」 → `## <version>（date）`,
//                                                   commit (landed on master), package, publish to the test channel, tag
//                                                   `<tool>-v<version>`; auto = every tool `due` lists; each step is
//                                                   shown on 问题页 (with this machine's platform login)
//   npm run release -- relay-service [--skip-tests] [--dry-run]
//                                                   AMO 中转's service and client content (relay-release, deploy: the service
//                                                   restarts when it changed), its version in packages/relay
//   npm run release -- promote <tool> <version>     the stable channel (relay-mac promote)
//   npm run release -- sync                         值守 directory: to master's tip, dependencies when the lock changed
//   npm run release -- land                         值守 directory: its commits onto master (a fast-forward of the main
//                                                   checkout); master moved meanwhile: rebase, verify again, land again
// Where: in the main checkout on master with nothing uncommitted under studio/packages and studio/scripts, or in the 值守
// directory (a worktree detached at master; plans/release.md): there it first moves to master's tip and installs the
// dependencies when package-lock.json changed, and the release commit is landed on master by a fast-forward of the main
// checkout. The package is always a commit of master, never what is on the disk of a checkout someone works in.
// Runs below normal priority (its builds and tests inherit it). A run that published some tools and then failed is
// picked up by the next one: a version committed but not tagged is published without another bump.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { join, resolve } from "node:path";
import { TOOLS, studio } from "./amo-tools.mjs";

const repo = resolve(studio, "..");
const args = process.argv.slice(2);
const [cmd = "status", ...rest] = args;
const has = (f) => rest.includes(f);
const flag = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--wait");
try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Not allowed here: run as it is.
}

// ---- what can be released

/**
 * Every target: the platform's tools (scripts/amo-tools.mjs) and 中转's service. pkg: where its version and CHANGELOG.md
 * are; paths: what counts as a change of it.
 */
const TARGETS = {
  ...Object.fromEntries(Object.entries(TOOLS).filter(([, t]) => t.platform).map(([id, t]) => [id, { id, label: t.description, pkg: t.pkg, paths: t.packages.map((p) => `studio/packages/${p}`) }])),
  "relay-service": { id: "relay-service", label: "中转服务", pkg: "relay", paths: ["studio/packages/relay", "studio/packages/relay-ui"], service: true },
};
const NEXT = "## 下一版";

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const gitOk = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" }).status === 0;
function run(command, argv, opts = {}) {
  console.log(`\n> ${command} ${argv.join(" ")}`);
  const res = spawnSync(command, argv, { cwd: studio, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.status !== 0) throw new Error(`${command} ${argv.join(" ")}: exit ${res.status}`);
}

// The service's version lives in RELAY_VERSION, not in packages/relay/package.json: the workspace's packages depend on
// each other at "0.0.0", and a different version there sends npm ci to the registry (404).
const PROTOCOL = join(studio, "packages", "relay", "src", "protocol.ts");
const VERSION_RE = /export const RELAY_VERSION = "([^"]+)";/;
const pkgFile = (t) => (t.service ? PROTOCOL : join(studio, "packages", t.pkg, "package.json"));
const changelogFile = (t) => join(studio, "packages", t.pkg, "CHANGELOG.md");
const versionOf = (t, text = readFileSync(pkgFile(t), "utf8")) => (t.service ? VERSION_RE.exec(text)[1] : JSON.parse(text).version);
const tagOf = (t, v) => `${t.id}-v${v}`;
const lastTag = (t) => git("tag", "--list", `${t.id}-v*`, "--sort=-v:refname").split("\n").filter(Boolean)[0] ?? null;
/** At a ref (master) when given, else as on disk. */
const show = (ref, file) => (ref ? execFileSync("git", ["show", `${ref}:${file}`], { cwd: repo, encoding: "utf8" }) : readFileSync(join(repo, file), "utf8"));
const rel = (file) => file.slice(repo.length + 1).split("\\").join("/");

/** The 「下一版」 section's entries (lines starting with "- "). */
function nextEntries(text) {
  const at = text.indexOf(`\n${NEXT}`);
  if (at < 0) return [];
  const body = text.slice(at + NEXT.length + 1);
  const end = body.search(/\n## /);
  return (end < 0 ? body : body.slice(0, end)).split("\n").filter((l) => l.startsWith("- "));
}

/** Commits on `ref` since the target's last tag that touch its paths: [{ sha, at (ms), subject }]; null when it has no tag yet. */
function changes(t, ref = "master") {
  const tag = lastTag(t);
  if (!tag) return null;
  const out = git("log", "--format=%H%x09%ct%x09%s", `${tag}..${ref}`, "--", ...t.paths);
  return out ? out.split("\n").map((l) => l.split("\t")).map(([sha, ct, subject]) => ({ sha, at: Number(ct) * 1000, subject })) : [];
}

const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 60 ? `${min} 分钟前` : min < 48 * 60 ? `${Math.round(min / 60)} 小时前` : `${Math.round(min / 1440)} 天前`;
};

/** What is waiting to go out on master: tools (not the service: deploying it restarts 中转) changed since their tag with entries. */
function due() {
  const out = [];
  for (const t of Object.values(TARGETS)) {
    if (t.service) continue;
    const ch = changes(t);
    const entries = nextEntries(show("master", rel(changelogFile(t))));
    if (!ch?.length || !entries.length) continue;
    out.push({ t, changes: ch, entries, oldest: Math.min(...ch.map((c) => c.at)) });
  }
  return out;
}

// ---- where this runs

/** The main checkout (master checked out) and this checkout's state. */
function where() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const list = git("worktree", "list", "--porcelain").split("\n\n");
  const main = list.map((b) => ({ path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch (.+)$/m.exec(b)?.[1] })).find((w) => w.branch === "refs/heads/master")?.path ?? null;
  return { branch, detached: branch === "HEAD", main };
}

function dirty() {
  return git("status", "--porcelain", "--", "studio/packages", "studio/scripts", "studio/package.json", "studio/package-lock.json").split("\n").filter(Boolean);
}

/** The dependencies match package-lock.json (installed once in the 值守 directory, again only when the lock changed). */
function ensureDeps() {
  const lock = join(studio, "package-lock.json");
  const stamp = join(studio, "node_modules", ".amo-lock-sha");
  const sha = createHash("sha256").update(readFileSync(lock)).digest("hex");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === sha) return;
  run("npm", ["ci"]);
  writeFileSync(stamp, sha);
}

/** Checks before anything changes: a commit of master, clean, entries written. Moves the 值守 directory to master's tip. */
function preflight(targets) {
  const w = where();
  if (!w.detached && w.branch !== "master") throw new Error(`在分支 ${w.branch} 上：只从 master 发布（主工作区的 master，或值守目录）`);
  const d = dirty();
  if (d.length) throw new Error(`有没提交的改动，不打包（包只从提交过的 master 打）：\n  ${d.join("\n  ")}\n主工作区有人在改时，到值守目录 ${join(repo + "-duty")} 里发布。`);
  if (w.detached) {
    git("checkout", "--detach", "master");
    console.log(`值守目录已到 master ${git("rev-parse", "--short", "HEAD")}`);
  }
  ensureDeps();
  const plan = [];
  for (const t of targets) {
    const version = versionOf(t);
    const text = readFileSync(changelogFile(t), "utf8");
    const entries = nextEntries(text);
    // A run that committed this version and failed before publishing it: publish it now, no new version.
    const resume = !gitOk("rev-parse", "-q", "--verify", `refs/tags/${tagOf(t, version)}`) && text.includes(`\n## ${version}（`) && !entries.length;
    if (!resume && !entries.length) throw new Error(`${t.label}：CHANGELOG.md 的「${NEXT.slice(3)}」里还没写改动说明（packages/${t.pkg}/CHANGELOG.md）`);
    plan.push({ t, from: version, resume, entries });
  }
  return { w, plan };
}

function bump(v, minor) {
  const [a, b, c] = v.split(".").map(Number);
  return minor ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Writes the new version: package.json (the service: RELAY_VERSION) and the CHANGELOG heading. */
function writeVersion(t, version) {
  const cl = changelogFile(t);
  const log = readFileSync(cl, "utf8");
  // CRLF in a checkout with core.autocrlf (the 值守 directory): 0.7.1 went out with its entries still under 「下一版」.
  const eol = log.includes("\r\n") ? "\r\n" : "\n";
  const next = new RegExp(`\\r?\\n${NEXT}\\r?\\n`);
  if (!next.test(log)) throw new Error(`${t.label}：CHANGELOG.md 里找不到「${NEXT.slice(3)}」这一节`);
  const pj = pkgFile(t);
  const text = readFileSync(pj, "utf8");
  writeFileSync(pj, t.service ? text.replace(VERSION_RE, `export const RELAY_VERSION = "${version}";`) : text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  // An empty 「下一版」 stays on top for the next change.
  writeFileSync(cl, log.replace(next, `${eol}${NEXT}${eol}${eol}## ${version}（${today()}）${eol}`));
  return [pj, cl];
}

/** Commits the release and lands it on master: directly in the main checkout, by a fast-forward from the 值守 directory. */
function commit(w, files, message) {
  git("add", ...files);
  git("commit", "-q", "-m", message);
  const sha = git("rev-parse", "HEAD");
  if (w.detached) {
    if (!w.main) throw new Error("找不到检出 master 的主工作区");
    const ff = spawnSync("git", ["merge", "--ff-only", "-q", sha], { cwd: w.main, encoding: "utf8" });
    if (ff.status !== 0) {
      git("checkout", "-q", "--detach", "master");
      throw new Error(`发布提交合不进 master（master 刚动过，或主工作区没提交的改动和它冲突），这次没发：\n${ff.stderr.trim()}`);
    }
  }
  return sha;
}

function tests() {
  if (has("--skip-tests")) return console.log("跳过了测试（--skip-tests）");
  run("npm", ["run", "typecheck"]);
  // One retry: a few tests are slow under below-normal priority with the desktop busy. Left out, by name: tests that
  // fail on the development machine for reasons of the machine, not of the change (run them on their own when touching
  // what they test).
  console.log(`不跑：${KNOWN_FLAKY.map((k) => `${k.file}（${k.why}）`).join("；")}`);
  run("npx", ["vitest", "run", "--maxWorkers=6", "--retry=1", ...KNOWN_FLAKY.flatMap((k) => ["--exclude", k.file])]);
}

const KNOWN_FLAKY = [
  // Since 2026-10 on this machine: under load a killed app-server's port is not released within the manager's 3 s, so
  // the server comes back on another port and the file's later tests (sharing that server) fail with it.
  { file: "packages/host/src/runtime/codex/server-manager.test.ts", why: "这台机器上端口释放慢，换了端口后整个文件跟着挂" },
];

/**
 * 问题页 shows the test build going on (2026-10-31, the user: 能够查看当前是否在打包，以及打包的进度): each step is
 * reported to the team server with this machine's platform login. Best effort: no login, or the server out of reach,
 * and the build goes on without it.
 */
async function buildReporter() {
  let account;
  try {
    const { readAccount } = await import("@amo-studio/account");
    account = await readAccount();
  } catch {
    account = null;
  }
  if (!account) {
    console.log("（没登录 AMO 平台：问题页上看不到这次打包的进度）");
    return async () => undefined;
  }
  return async (report) => {
    try {
      const res = await fetch(`${account.server}/api/issues/release/build`, { method: "POST", headers: { authorization: `Bearer ${account.key}`, "content-type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(5000) });
      if (!res.ok) console.log(`（问题页没收到打包进度：${res.status}）`);
    } catch (err) {
      console.log(`（问题页没收到打包进度：${err.message}）`);
    }
  };
}

// ---- commands

function status() {
  for (const t of Object.values(TARGETS)) {
    const tag = lastTag(t);
    const ch = changes(t);
    const entries = nextEntries(readFileSync(changelogFile(t), "utf8"));
    const since = ch === null ? "还没有发布 tag" : ch.length ? `之后 ${ch.length} 个提交（最早 ${ago(Math.min(...ch.map((c) => c.at)))}）` : "之后没有改动";
    console.log(`${t.label.padEnd(10)} ${versionOf(t).padEnd(8)} 上次 ${tag ?? "—"}，${since}；「下一版」${entries.length} 条`);
  }
  console.log("");
  run(process.execPath, [join(studio, "scripts", "relay-mac.mjs"), "platform-status"], { shell: false });
}

async function release(ids) {
  const targets = ids.map((id) => TARGETS[id] ?? (() => { throw new Error(`没有这个工具：${id}（${Object.keys(TARGETS).join("、")}）`); })());
  if (!targets.length) return console.log("没有要发布的。");
  const service = targets.filter((t) => t.service);
  if (service.length && targets.length > 1) throw new Error("中转服务单独发：npm run release -- relay-service");
  const { w, plan } = preflight(targets);
  // 2026-10-31: 0.7.1, deployed from the 值守 directory, dropped a feature another session had deployed straight from
  // the main checkout without committing. The server holds one build: relay changes left uncommitted there would go.
  if (service.length && w.main && !has("--main-dirty-ok")) {
    const left = spawnSync("git", ["status", "--porcelain", "--", ...service[0].paths.map((p) => p.replace(/^studio\//, ""))], { cwd: join(w.main, "studio"), encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    if (left.length) throw new Error(`主工作区有没提交的中转改动，部署会把服务器上它们的效果冲掉（如果已经直接部署过）：\n  ${left.join("\n  ")}\n先提交进 master（或确认没部署过），再发；确定不要它们时加 --main-dirty-ok。`);
  }
  for (const p of plan) p.to = p.resume ? p.from : bump(p.from, has("--minor"));
  console.log(`\n要发布：${plan.map((p) => `${p.t.label} ${p.to}${p.resume ? "（上次提交了没发出去，这次补发）" : ""}`).join("、")}`);
  for (const p of plan) for (const e of p.entries) console.log(`  ${p.t.label} ${e}`);
  if (has("--dry-run")) return console.log("\n--dry-run：到这里为止，什么都没改。");
  // The service restarts 中转 while it deploys: its builds are not shown on 问题页.
  if (service.length) return publishService(w, plan, service[0]);

  const fresh = plan.filter((p) => !p.resume);
  const steps = ["测试", ...(fresh.length ? ["提交版本"] : []), "打包", "发布"];
  const report = await buildReporter();
  const at = (name) => report({ step: steps.indexOf(name) });
  await report({ start: { label: plan.map((p) => `${p.t.label} ${p.to}`).join("、"), steps } });
  try {
    tests();
    let sha = git("rev-parse", "HEAD");
    if (fresh.length) {
      await at("提交版本");
      const files = fresh.flatMap((p) => writeVersion(p.t, p.to));
      const names = fresh.map((p) => `${p.t.label} ${p.to}`).join("、");
      sha = commit(w, files, `chore(release): test channel — ${names}${has("--skip-tests") ? "（没跑测试）" : ""}`);
      console.log(`\n已提交 ${sha.slice(0, 7)}，在 master 上`);
    }
    await at("打包");
    run("npm", ["run", "package:platform", "--", "--only", plan.map((p) => p.t.id).join(",")]);
    await at("发布");
    const done = [];
    const failed = [];
    for (const p of plan) {
      try {
        run(process.execPath, [join(studio, "scripts", "relay-mac.mjs"), "publish", p.t.id], { shell: false });
        git("tag", tagOf(p.t, p.to), sha);
        done.push(p);
      } catch (err) {
        console.error(`\n${p.t.label} ${p.to} 没发出去：${err.message}`);
        failed.push(`${p.t.label} ${p.to}`);
      }
    }
    console.log(`\n已发布到测试通道：${done.map((p) => `${p.t.label} ${p.to}`).join("、") || "无"}`);
    for (const p of done) console.log(`  转正式版：npm run release -- promote ${p.t.id} ${p.to}`);
    if (done.length < plan.length) {
      console.log("没发出去的下次再跑 release 会补发（版本号不再加）。");
      process.exitCode = 1;
    }
    await report({ end: { ok: !failed.length, message: [done.length ? `已发到测试通道：${done.map((p) => `${p.t.label} ${p.to}`).join("、")}` : "", failed.length ? `没发出去：${failed.join("、")}` : ""].filter(Boolean).join("；") } });
  } catch (err) {
    // The step it was at stays as where it stopped.
    await report({ end: { ok: false, message: err.message } });
    throw err;
  }
}

/** 中转's service: its version committed, its content built and deployed (the service restarts). */
function publishService(w, plan, t) {
  tests();
  const fresh = plan.filter((p) => !p.resume);
  let sha = git("rev-parse", "HEAD");
  if (fresh.length) {
    sha = commit(w, fresh.flatMap((p) => writeVersion(p.t, p.to)), `chore(release): 中转服务 ${fresh[0].to}${has("--skip-tests") ? "（没跑测试）" : ""}`);
    console.log(`\n已提交 ${sha.slice(0, 7)}，在 master 上`);
  }
  // The desktop client's zip only when its shell changed since the last deploy.
  const tag = lastTag(t);
  const shell = !tag || git("diff", "--name-only", tag, sha, "--", "studio/packages/relay-app", "studio/packages/relay/src/shell-api.ts") !== "";
  run(process.execPath, [join(studio, "scripts", "relay-release.mjs"), ...(shell ? ["--shell"] : [])], { shell: false });
  run(process.execPath, [join(studio, "scripts", "relay-mac.mjs"), "deploy"], { shell: false });
  git("tag", tagOf(t, plan[0].to), sha);
  console.log(`\n中转服务 ${plan[0].to} 已部署，tag ${tagOf(t, plan[0].to)}`);
}

try {
  switch (cmd) {
    case "status":
      status();
      break;
    case "due": {
      const wait = Number(flag("--wait") ?? 0) * 60_000;
      const list = due();
      if (!list.length || Date.now() - Math.min(...list.map((d) => d.oldest)) < wait) break;
      // No times in the lines: the same state reads the same (值守 does not act twice on one finding).
      for (const d of list) console.log(`该发布：${d.t.label}（${d.t.id}）上次发布后 ${d.changes.length} 个提交，「下一版」${d.entries.length} 条`);
      break;
    }
    case "sync": {
      const w = where();
      if (!w.detached) throw new Error("sync 只在值守目录里用（master 的 detached worktree）");
      const d = dirty();
      if (d.length) throw new Error(`值守目录有没提交的改动，先提交（再 land）或丢掉：\n  ${d.join("\n  ")}`);
      const ahead = git("rev-list", "--count", "master..HEAD");
      if (ahead !== "0") throw new Error(`值守目录有 ${ahead} 个提交还没进 master：先 npm run release -- land`);
      git("checkout", "-q", "--detach", "master");
      ensureDeps();
      console.log(`值守目录已到 master ${git("rev-parse", "--short", "HEAD")}`);
      break;
    }
    case "land": {
      const w = where();
      if (!w.detached) throw new Error("land 只在值守目录里用；主工作区里直接提交到 master 就行");
      if (!w.main) throw new Error("找不到检出 master 的主工作区");
      const head = git("rev-parse", "HEAD");
      if (gitOk("merge-base", "--is-ancestor", head, "master")) {
        console.log("没有要合的：值守目录的提交都已经在 master 上");
        break;
      }
      if (!gitOk("merge-base", "--is-ancestor", "master", head)) throw new Error("master 在这之后又有了提交：先 git rebase master，重新验证，再 land");
      const ff = spawnSync("git", ["merge", "--ff-only", "-q", head], { cwd: w.main, encoding: "utf8" });
      if (ff.status !== 0) throw new Error(`合不进 master（主工作区没提交的改动碰到了同样的文件）：提交留在值守目录，等人处理\n${ff.stderr.trim()}`);
      git("checkout", "-q", "--detach", "master");
      console.log(`已合进 master：${git("log", "--format=%h %s", "-1")}`);
      break;
    }
    case "promote":
      run(process.execPath, [join(studio, "scripts", "relay-mac.mjs"), "promote", ...positional], { shell: false });
      break;
    case "auto":
      await release(due().map((d) => d.t.id));
      break;
    default:
      await release([cmd, ...positional]);
  }
} catch (err) {
  // What stopped it, as a sentence (the runs before it printed their own output).
  console.error(`\n发布停下了：${err.message}`);
  process.exitCode = 1;
}
