// AMO 中转's service on the team Mac (2026-10-28), driven from here over SSH (alias `mac` in ~/.ssh/config):
//   ~/Services/amo-relay/app/    release/relay as built here (service, client content, downloads); replaced on deploy
//   ~/Services/amo-relay/data/   relay.db and uploaded files; deploy never touches it
//   ~/Services/amo-relay/platform/   the AMO platform's tools (platform-publish.mjs), given to the service as --platform-dir;
//                                deploy only makes sure it exists
//   ~/Library/LaunchAgents/com.amo.relay.plist   started at login, restarted when it stops; logs in ~/Library/Logs/AMO Relay
//   node scripts/relay-mac.mjs deploy            send release/relay (npm run relay:release first); a changed service restarts
//                              status | start | stop | restart | logs [lines]
//                              passwd <名字> [新密码]       reset someone's password (a random one when left out) and print it
//                              backup                        a copy of the database in data/backup-<time>.db
//                              migrate --from <data dir> [--force]   one-off: a running service's data copied over
//   The AMO platform (2026-10-28, plans/amo-lan-platform.md):
//                              publish <tool> [--channel test|stable] [--notes "…"] [--release <dir>]
//                                  release/<Name>/ (npm run package:portable -- --only <tool>) as the tool's version
//                                  (its package.json) on a channel (test when left out); notes from its CHANGELOG.md
//                              promote <tool> <version>     the stable channel to a version already published
//                              platform-status              both channels' versions per tool, and what is stored
//                              --target-dir <dir>           any of the three on a folder here instead of the Mac (tests,
//                                                           or a relay service started here with --platform-dir <dir>)
// SSH_HOST=<alias> to use another machine. Content updates need no restart: the service reads app/client per request.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, changelogSection, tool, toolVersion } from "./amo-tools.mjs";
import { LocalTarget, ShellTarget, mb, promote, publish, status } from "./platform-publish.mjs";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(studio, "release", "relay");
const host = process.env.SSH_HOST ?? "mac";
const LABEL = "com.amo.relay";
const PORT = 47120;
const [cmd = "status", ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
/** The arguments that are not flags or their values (every flag of these commands takes a value, except --force). */
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1]?.startsWith("--") && rest[i - 1] !== "--force"));

/** The shell code every remote script starts with: where things are, and how to reach launchd. */
const PRELUDE = `set -e
ROOT="$HOME/Services/amo-relay"; APP="$ROOT/app"; DATA="$ROOT/data"; PLATFORM="$ROOT/platform"; LOGS="$HOME/Library/Logs/AMO Relay"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"; DOMAIN="gui/$(id -u)"
NODE="$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)"
export PATH="$(dirname "$NODE"):$PATH"
health() { curl -s -m 3 "http://127.0.0.1:${PORT}/api/health" || echo "(no answer on port ${PORT})"; echo; }
`;

/** Runs a bash script on the Mac, sent on stdin (no quoting through the remote login shell). */
function remote(script, { capture = false } = {}) {
  const res = spawnSync("ssh", ["-o", "BatchMode=yes", host, "/bin/bash", "-s"], { input: PRELUDE + script, stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ssh ${host}: exit ${res.status}`);
  return res.stdout;
}

/** tar of `dir` (the listed entries) straight into a folder on the Mac. */
function upload(dir, entries, target) {
  return new Promise((done, fail) => {
    const tar = spawn("tar", ["-cf", "-", ...entries], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
    const ssh = spawn("ssh", ["-o", "BatchMode=yes", host, `/bin/bash -c 'rm -rf "${target}" && mkdir -p "${target}" && tar -xf - -C "${target}"'`], { stdio: ["pipe", "inherit", "inherit"] });
    tar.stdout.pipe(ssh.stdin);
    tar.on("error", fail);
    ssh.on("close", (code) => (code === 0 ? done() : fail(new Error(`upload to ${host}: exit ${code}`))));
  });
}

const plist = () => `cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$APP/amo-relay.mjs</string><string>serve</string>
    <string>--data</string><string>$DATA</string><string>--port</string><string>${PORT}</string>
    <string>--platform-dir</string><string>$PLATFORM</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/serve.log</string>
  <key>StandardErrorPath</key><string>$LOGS/serve.err.log</string>
</dict></plist>
EOF
`;

const START = `mkdir -p "$DATA" "$PLATFORM" "$LOGS" "$HOME/Library/LaunchAgents"
${plist()}
launchctl bootout "$DOMAIN/${LABEL}" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null && break; sleep 1; done
health
`;

const BACKUP = `if [ -f "$DATA/relay.db" ]; then
  B="$DATA/backup-$(date +%Y%m%d-%H%M%S).db"
  "$NODE" -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("VACUUM INTO \\x27"+process.argv[2]+"\\x27");d.close()' "$DATA/relay.db" "$B"
  echo "backup: $B"
fi
`;

/** Where publish / promote / platform-status work: the Mac's platform dir over SSH, or a folder here (--target-dir). */
function platformTarget() {
  const dir = flag("--target-dir");
  if (dir) return new LocalTarget(resolve(dir));
  return new ShellTarget({ run: (script, { capture }) => remote(script, { capture }), upload, root: "$HOME/Services/amo-relay/platform", where: `${host}:~/Services/amo-relay/platform` });
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

switch (cmd) {
  case "deploy": {
    if (!existsSync(join(release, "client", "manifest.json"))) throw new Error("release/relay is missing: npm run relay:release first");
    // The desktop client's zip (150 MB) only when it changed.
    const there = remote(`echo "zip $(shasum -a 256 "$APP/downloads/AMO-Relay-win.json" 2>/dev/null | cut -d" " -f1)"; echo "svc $(shasum -a 256 "$APP/amo-relay.mjs" 2>/dev/null | cut -d" " -f1)"`, { capture: true });
    const hashThere = (key) => new RegExp(`^${key} (\\w*)`, "m").exec(there)?.[1] ?? "";
    const zipJson = join(release, "downloads", "AMO-Relay-win.json");
    const zipSame = existsSync(zipJson) && hashThere("zip") === sha(zipJson);
    const serviceChanged = hashThere("svc") !== sha(join(release, "amo-relay.mjs"));
    const entries = ["amo-relay.mjs", "client", ...(zipSame || !existsSync(zipJson) ? [] : ["downloads"])];
    console.log(`uploading ${entries.join(", ")} to ${host}…`);
    await upload(release, entries, "$HOME/Services/amo-relay/incoming");
    // Whole folders renamed into place, the client last, so the service never hands out half of one.
    remote(`IN="$ROOT/incoming"; mkdir -p "$APP" "$PLATFORM"
if [ -d "$IN/downloads" ]; then rm -rf "$APP/downloads.old"; [ -d "$APP/downloads" ] && mv "$APP/downloads" "$APP/downloads.old"; mv "$IN/downloads" "$APP/downloads"; rm -rf "$APP/downloads.old"; fi
${serviceChanged ? BACKUP : ""}cp "$IN/amo-relay.mjs" "$APP/amo-relay.mjs.new" && mv "$APP/amo-relay.mjs.new" "$APP/amo-relay.mjs"
rm -rf "$APP/client.old"; [ -d "$APP/client" ] && mv "$APP/client" "$APP/client.old"; mv "$IN/client" "$APP/client"; rm -rf "$APP/client.old" "$IN"
echo "client $(grep -m1 '"version"' "$APP/client/manifest.json")"
if ${serviceChanged ? "true" : `! launchctl print "$DOMAIN/${LABEL}" >/dev/null 2>&1`}; then
echo "${serviceChanged ? "service changed" : "not running"}: (re)starting"
${START}
else health; fi`);
    break;
  }
  case "start":
  case "restart":
    remote(START);
    break;
  case "stop":
    remote(`launchctl bootout "$DOMAIN/${LABEL}" 2>/dev/null && echo stopped || echo "not running"`);
    break;
  case "status":
    remote(`launchctl print "$DOMAIN/${LABEL}" 2>/dev/null | grep -E "^\\s+(state|pid|last exit code) =" || echo "not loaded"
echo "app: $APP"; echo "data: $DATA"; health`);
    break;
  case "logs":
    remote(`tail -n ${Number(rest[0]) || 40} "$LOGS/serve.log" "$LOGS/serve.err.log"`);
    break;
  case "backup":
    remote(BACKUP);
    break;
  case "passwd": {
    const [name, given] = rest;
    if (!name) throw new Error("usage: relay-mac.mjs passwd <名字> [新密码]");
    const password = given ?? Array.from({ length: 8 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[randomInt(31)]).join("");
    // Names are Chinese: sent as base64 so no shell or code page in between changes them.
    remote(`"$NODE" "$APP/amo-relay.mjs" passwd --data "$DATA" "$(echo ${b64(name)} | base64 -D)" "$(echo ${b64(password)} | base64 -D)"`);
    console.log(`新密码：${password}`);
    break;
  }
  case "migrate": {
    const from = flag("--from");
    if (!from || !existsSync(join(from, "relay.db"))) throw new Error("usage: relay-mac.mjs migrate --from <folder with relay.db> [--force]");
    const has = remote(`[ -f "$DATA/relay.db" ] && echo yes || echo no`, { capture: true }).trim();
    if (has === "yes" && !rest.includes("--force")) throw new Error(`${host} already has data/relay.db; --force replaces it (a backup is made first)`);
    // A consistent copy of a database that may be in use (WAL), plus the uploaded files.
    const snap = mkdtempSync(join(tmpdir(), "relay-migrate-"));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(from, "relay.db"));
    db.exec(`VACUUM INTO '${join(snap, "relay.db").replace(/'/g, "''")}'`);
    db.close();
    await upload(snap, ["relay.db"], "$HOME/Services/amo-relay/migrate");
    if (existsSync(join(from, "files"))) await upload(from, ["files"], "$HOME/Services/amo-relay/migrate-files");
    rmSync(snap, { recursive: true, force: true });
    remote(`launchctl bootout "$DOMAIN/${LABEL}" 2>/dev/null || true
mkdir -p "$DATA"; ${BACKUP}rm -f "$DATA/relay.db" "$DATA/relay.db-wal" "$DATA/relay.db-shm"
mv "$ROOT/migrate/relay.db" "$DATA/relay.db"; rm -rf "$ROOT/migrate"
if [ -d "$ROOT/migrate-files/files" ]; then rm -rf "$DATA/files"; mv "$ROOT/migrate-files/files" "$DATA/files"; fi; rm -rf "$ROOT/migrate-files"
echo "data in place"
${START}`);
    break;
  }
  case "publish": {
    const [id] = positional;
    if (!id) throw new Error('usage: relay-mac.mjs publish <tool> [--channel test|stable] [--notes "…"] [--release <dir>] [--target-dir <dir>]');
    const t = tool(id);
    const version = toolVersion(id);
    const notes = flag("--notes") ?? changelogSection(id, version);
    if (!notes) throw new Error(`packages/${t.pkg}/CHANGELOG.md 里没有 ${version} 这一节：写上再发布，或者用 --notes "…"`);
    const channel = flag("--channel") ?? "test";
    const target = platformTarget();
    const dir = join(resolve(studio, flag("--release") ?? "release"), t.name);
    const r = await publish(target, { id, dir, version, notes, channel, log: (s) => console.log(s) });
    console.log(`${r.existed ? "这个版本已经发布过，文件相同：只改了通道" : "已发布"}：${id} ${version} → ${channel === "stable" ? "稳定" : "测试"}通道（${target.where}）`);
    console.log(`${r.manifest.files.length} 个文件，新上传 ${r.uploaded.length} 个（${mb(r.uploadedBytes)}）`);
    if (channel === "test") console.log(`转成正式版：npm run relay:mac -- promote ${id} ${version}${flag("--target-dir") ? ` --target-dir "${flag("--target-dir")}"` : ""}`);
    break;
  }
  case "promote": {
    const [id, version] = positional;
    if (!id || !version) throw new Error("usage: relay-mac.mjs promote <tool> <version> [--target-dir <dir>]");
    const target = platformTarget();
    const channels = await promote(target, { id, version });
    console.log(`稳定通道：${id} ${channels.stable[id]}；测试通道：${id} ${channels.test[id]}（${target.where}）`);
    break;
  }
  case "platform-status": {
    const target = platformTarget();
    console.log(`AMO 平台（${target.where}）`);
    console.log(await status(target, { tools: Object.keys(TOOLS).filter((id) => TOOLS[id].platform) }));
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}: deploy | status | start | stop | restart | logs | passwd | backup | migrate | publish | promote | platform-status`);
}
