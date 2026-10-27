// AMO 中转's release folder (2026-10-26, plans/relay.md) — what the service serves and runs from:
//   <out>/amo-relay.mjs          the service, CLI and MCP in one file (plain Node 22.13+, also on a Mac)
//   <out>/client/                the client's content + manifest.json: the desktop client's hot update, /app/ in a browser
//   <out>/downloads/AMO-Relay-win.zip   the desktop client (with --shell)
//   node scripts/relay-release.mjs [--out <dir>] [--shell [--pack <dir>]]    (npm run relay:release [-- --shell])
// Publishing a client update = run this again (without --shell); a running service hands it out at once. The shell
// only needs rebuilding when packages/relay-app or shell-api.ts changes (then bump SHELL_VERSION).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = resolve(studio, flag("--out") ?? "release/relay");
const withShell = args.includes("--shell");
const bin = (name) => join(studio, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
/** Windows: a folder just written can be held a moment (antivirus, indexer); a rename then fails with EPERM. */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
// The node_modules/.bin tools are .cmd files on Windows, which need a shell; node itself is run directly.
const run = (cmd, argv, cwd = studio) => execFileSync(cmd, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd.endsWith(".cmd") });

// 1. Build: the relay package and the shell (tsc), the content (vite), the one-file service (rolldown).
run(bin("tsc"), ["-b", "packages/relay", "packages/relay-app"]);
run(bin("vite"), ["build"], join(studio, "packages", "relay-ui"));
mkdirSync(out, { recursive: true });
run(bin("rolldown"), ["packages/relay/dist/bin.js", "--platform", "node", "--format", "esm", "--file", join(out, "amo-relay.mjs")]);

// 2. The content, built next to the live one and swapped in, so the service never serves half of it.
const now = new Date();
const p = (n) => String(n).padStart(2, "0");
const version = `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
const shellVersion = Number(/SHELL_VERSION = (\d+)/.exec(readFileSync(join(studio, "packages", "relay", "src", "shell-api.ts"), "utf8"))?.[1] ?? 1);
const fresh = join(out, "client.new");
rmSync(fresh, { recursive: true, force: true });
cpSync(join(studio, "packages", "relay-ui", "dist"), fresh, { recursive: true });
cpSync(join(out, "amo-relay.mjs"), join(fresh, "amo-relay.mjs"));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else {
      const data = readFileSync(file);
      files.push({ path: relative(fresh, file).split(sep).join("/"), size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
})(fresh);
writeFileSync(join(fresh, "manifest.json"), JSON.stringify({ version, builtAt: now.getTime(), minShell: shellVersion, files }, null, 2));
const live = join(out, "client");
const old = join(out, "client.old");
rmSync(old, { recursive: true, force: true });
if (existsSync(live)) renameRetry(live, old);
renameRetry(fresh, live);
rmSync(old, { recursive: true, force: true });
console.log(`client ${version}: ${files.length} files, ${(files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(0)} KB`);

// 3. The desktop client's zip (the portable layout of scripts/package-portable.mjs).
if (withShell) {
  // --pack <dir>: build the client elsewhere, e.g. while the one in release/relay-pack is running (its files are locked).
  const pack = resolve(studio, flag("--pack") ?? join("release", "relay-pack"));
  run(process.execPath, [join(studio, "scripts", "package-portable.mjs"), pack, "--zip", "--only", "relay"]);
  const zip = readdirSync(pack).find((n) => /^AMO-Relay-.*\.zip$/.test(n));
  if (!zip) throw new Error("the desktop client's zip is missing");
  mkdirSync(join(out, "downloads"), { recursive: true });
  for (const n of readdirSync(join(out, "downloads"))) if (n.endsWith(".zip")) rmSync(join(out, "downloads", n));
  renameRetry(join(pack, zip), join(out, "downloads", "AMO-Relay-win.zip"));
  console.log(`desktop client: ${join(out, "downloads", "AMO-Relay-win.zip")}`);
}
console.log(`release folder: ${out}\nrun the service: node "${join(out, "amo-relay.mjs")}" serve`);
