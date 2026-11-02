// The iOS app to TestFlight from one commit (2026-11-02, plans/ios.md「发布流程」): npm run release -- ios calls it after
// the release commit; on its own it is for trying a build:
//   node scripts/ios-release.mjs <commit> [--no-upload]
//   node scripts/ios-release.mjs --install-agent     once per build Mac (and when mobile/iosApp/agent changes)
// The commit's studio/mobile goes to the build Mac (ssh mac) by git archive — what was committed, not what is on disk —
// into ~/amo-ios-build/src/<short sha>/; iosApp/build-on-mac.sh builds, checks and uploads it there and its steps are
// printed here. It runs under the LaunchAgent com.amo.ios-build, in the Mac's desktop session at nice 10: codesign
// needs the login keychain, which ssh cannot use (errSecInternalComponent, 2026-11-02); ssh only queues the job
// (iosApp/submit-build.sh) and follows it. Its logs come back to studio/release/ios/<version>-<build>/ (ignored by git). The version is
// the commit's Version.xcconfig; the build number (CFBundleVersion) the commit's count on its history, so it only grows
// and says which commit it is. Nothing here reads or sends the App Store Connect key: it stays on the Mac.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { studio } from "./amo-tools.mjs";

const repo = resolve(studio, "..");
export const VERSION_FILE = "studio/mobile/iosApp/Version.xcconfig";
// The line's end left alone: CRLF in a checkout with core.autocrlf (the 值守 directory).
export const MARKETING_RE = /^MARKETING_VERSION[ \t]*=[ \t]*(\S+)[ \t]*(?=\r?$)/m;
/** build-on-mac.sh's exit codes: 10 + the step it stopped at; step 1 = the Mac is busy (Unity, another build). */
export const BUSY_EXIT = 11;
/** submit-build.sh: the agent is not installed, or did not take the job. */
export const NO_AGENT_EXIT = 9;

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

/** MARKETING_VERSION in a Version.xcconfig's text. */
export function marketingVersion(text) {
  const v = MARKETING_RE.exec(text)?.[1];
  if (!v) throw new Error(`${VERSION_FILE} 里找不到 MARKETING_VERSION`);
  return v;
}

/** The text with MARKETING_VERSION set to `version` (release.mjs's version bump). */
export function withMarketingVersion(text, version) {
  marketingVersion(text);
  return text.replace(MARKETING_RE, `MARKETING_VERSION = ${version}`);
}

/** The commands, as data (the unit test checks them; nothing interpolates into a remote shell but checked values). */
export function plan(sha, version, build, { upload = true } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`不是完整的提交号：${sha}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号不对：${version}`);
  if (!/^\d+$/.test(String(build))) throw new Error(`构建号不对：${build}`);
  const dir = `amo-ios-build/src/${sha.slice(0, 10)}`;
  return {
    dir,
    archive: ["-c", "core.autocrlf=false", "archive", "--format=tar", sha, "studio/mobile"],
    unpack: `rm -rf ~/${dir} && mkdir -p ~/${dir} && tar -xf - -C ~/${dir}`,
    build: `bash ~/${dir}/studio/mobile/iosApp/submit-build.sh ~/${dir}/studio/mobile ${version} ${build}${upload ? "" : " --no-upload"}`,
    logs: `amo-ios-build/logs/${version}-${build}`,
  };
}

/** Builds and (unless upload is false) uploads `sha`; resolves { version, build }, rejects with err.busy when the Mac is busy. */
export async function releaseIos(sha, { upload = true, log = console.log } = {}) {
  const full = git("rev-parse", `${sha}^{commit}`);
  const version = marketingVersion(git("show", `${full}:${VERSION_FILE}`));
  const build = Number(git("rev-list", "--count", full));
  const p = plan(full, version, build, { upload });
  log(`iOS ${version}（构建号 ${build}，提交 ${full.slice(0, 7)}）→ 打包机`);

  // git archive | ssh mac tar -x, without a temporary file.
  await new Promise((done, fail) => {
    const tar = spawn("git", p.archive, { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
    const ssh = spawn("ssh", ["mac", p.unpack], { stdio: ["pipe", "inherit", "inherit"] });
    tar.stdout.pipe(ssh.stdin);
    let left = 2;
    const end = (what) => (code) => {
      if (code !== 0) fail(new Error(`把代码送到打包机时 ${what} 失败（退出码 ${code}）`));
      else if (--left === 0) done();
    };
    tar.on("close", end("git archive"));
    ssh.on("close", end("ssh"));
  });

  const res = spawnSync("ssh", ["mac", p.build], { stdio: "inherit" });
  // The Mac's logs, whatever happened.
  const local = join(studio, "release", "ios", `${version}-${build}`);
  mkdirSync(local, { recursive: true });
  const copied = spawnSync("scp", ["-q", "-r", `mac:${p.logs}/.`, local], { stdio: "inherit" });
  log(copied.status === 0 ? `日志在 ${local}` : `（日志没拷回来，在打包机的 ~/${p.logs}）`);
  if (res.status !== 0) {
    const err = new Error(res.status === BUSY_EXIT ? "打包机正忙（Unity 在出包或者有别的构建），这次没打 iOS 包" : res.status === NO_AGENT_EXIT ? "打包机上的 com.amo.ios-build 没接任务（没装：node scripts/ios-release.mjs --install-agent；或者桌面没登录）" : `iOS 打包失败（build-on-mac.sh 退出码 ${res.status}，第 ${res.status - 10} 步），见上面的输出和 ${local}`);
    err.busy = res.status === BUSY_EXIT;
    throw err;
  }
  return { version, build };
}

/**
 * The LaunchAgent on the build Mac, from this checkout's mobile/iosApp/agent (the user agreed to it, 2026-11-02):
 * runner.sh to ~/amo-ios-build/agent/, the plist (with the Mac's home) to ~/Library/LaunchAgents/, loaded into the
 * desktop session again. Touches nothing else there.
 */
export function installAgent() {
  const agent = join(studio, "mobile", "iosApp", "agent");
  const step = (what, cmd, argv, input) => {
    const r = spawnSync(cmd, argv, { stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], input });
    if (r.status !== 0) throw new Error(`${what}失败（退出码 ${r.status}）`);
  };
  step("建目录", "ssh", ["mac", "mkdir -p ~/amo-ios-build/agent ~/amo-ios-build/queue ~/amo-ios-build/jobs ~/Library/LaunchAgents"]);
  step("拷 runner.sh", "scp", ["-q", join(agent, "runner.sh"), "mac:amo-ios-build/agent/runner.sh"]);
  const plist = readFileSync(join(agent, "com.amo.ios-build.plist"), "utf8");
  step("写 plist", "ssh", ["mac", 'sed "s#HOME/#$HOME/#g" > ~/Library/LaunchAgents/com.amo.ios-build.plist && plutil -lint ~/Library/LaunchAgents/com.amo.ios-build.plist'], plist);
  step("载入", "ssh", ["mac", 'launchctl bootout "gui/$(id -u)/com.amo.ios-build" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.amo.ios-build.plist && launchctl print "gui/$(id -u)/com.amo.ios-build" | grep -E "state|path" | head -3']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--install-agent")) {
    try {
      installAgent();
      console.log("com.amo.ios-build 已装好，在打包机的桌面会话里");
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
    process.exit();
  }
  const sha = args.find((a) => !a.startsWith("--"));
  if (!sha) {
    console.error("用法：node scripts/ios-release.mjs <提交> [--no-upload]");
    process.exit(2);
  }
  releaseIos(sha, { upload: !args.includes("--no-upload") }).then(
    ({ version, build }) => console.log(`\niOS ${version}（${build}）${args.includes("--no-upload") ? "打包完成，没上传" : "已上传到 TestFlight"}`),
    (err) => {
      console.error(`\n${err.message}`);
      process.exitCode = 1;
    },
  );
}
