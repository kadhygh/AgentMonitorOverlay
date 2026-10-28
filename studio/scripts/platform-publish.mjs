// Publishing the AMO tools for the platform (2026-10-28, plans/amo-lan-platform.md 「第一版的接口约定」): the core of
// relay-mac.mjs publish / promote / platform-status, kept apart from SSH so it can be tested and pointed at a local folder.
// The platform dir (on the Mac $ROOT/platform, next to app/ and data/; the relay service reads it, packages/relay/src/platform.ts):
//   objects/<sha256 first two>/<sha256>   file contents by sha256, each stored once
//   tools/<tool>/<version>.json           { tool, name, version, builtAt, exe, notes, files: [{ path, size, sha256 }] }
//   channels.json                         { "stable": { "studio": "0.9.0", … }, "test": { … } }
// A publish: hash the program folder (release/<Name>/, from package-portable.mjs), ask the target which objects it lacks,
// send only those, then write the manifest, then the channel — each step only after the one it depends on, each file
// written beside its place and renamed in, so a reader never sees a manifest whose files are not there yet.
// Two targets: LocalTarget (a folder on this machine: tests, or a relay service started here with --platform-dir) and
// ShellTarget (bash on the far side of a runner: relay-mac.mjs gives it SSH to the Mac).
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tool } from "./amo-tools.mjs";

// The same patterns as the service (packages/relay/src/platform.ts).
export const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const CHANNELS = ["test", "stable"];

/** sha256 of a file, streamed (Electron's own files are over 100 MB). */
export function hashFile(file) {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The version package-portable wrote into the program folder (resources/app/package.json), or null. */
export function builtVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "resources", "app", "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The manifest of a program folder, and where each object's content is on this machine. `builtAt` is when the folder
 * was written (its newest file), in ms.
 */
export async function buildManifest(id, dir, { version, notes }) {
  const t = tool(id);
  const files = [];
  const sources = new Map();
  let builtAt = 0;
  for (const file of walk(dir)) {
    const path = relative(dir, file).split(sep).join("/");
    const st = statSync(file);
    const sha256 = await hashFile(file);
    files.push({ path, size: st.size, sha256 });
    if (!sources.has(sha256)) sources.set(sha256, file);
    builtAt = Math.max(builtAt, Math.round(st.mtimeMs));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const exe = `${t.name}.exe`;
  if (!files.some((f) => f.path === exe)) throw new Error(`${dir} 里没有 ${exe}：这不是 ${t.name} 的程序文件夹`);
  return { manifest: { tool: id, name: t.name, version, builtAt, exe, notes, files }, sources };
}

const fileKey = (f) => `${f.path}\0${f.size}\0${f.sha256}`;
export function sameFiles(a, b) {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(fileKey));
  return b.every((f) => keys.has(fileKey(f)));
}

/** -1, 0, 1 like semver: numbers compared as numbers, a prerelease before its release. */
export function compareVersions(a, b) {
  const [ma, pa] = a.split(/-(.*)/s);
  const [mb, pb] = b.split(/-(.*)/s);
  const na = ma.split(".").map(Number);
  const nb = mb.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1;
  if (!pa !== !pb) return pa ? -1 : 1;
  if (!pa) return 0;
  const xa = pa.split(".");
  const xb = pb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    if (xa[i] === xb[i]) continue;
    const da = /^\d+$/.test(xa[i]);
    const db = /^\d+$/.test(xb[i]);
    if (da && db) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    if (da !== db) return da ? -1 : 1;
    return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

function emptyChannels() {
  return { stable: {}, test: {} };
}

/**
 * Points a channel at a version. Stable never runs ahead of test: when stable gets a version newer than test's (or test
 * has none), test gets it too, so the test channel is always the newest a person can have.
 */
function pointChannel(channels, channel, id, version) {
  const next = { ...emptyChannels(), ...channels };
  next[channel] = { ...next[channel], [id]: version };
  if (channel === "stable" && (!next.test[id] || compareVersions(next.test[id], version) < 0)) next.test = { ...next.test, [id]: version };
  return next;
}

function check(id, version, channel) {
  if (!TOOL_ID.test(id)) throw new Error(`工具名不对：${id}`);
  if (!tool(id).platform) throw new Error(`${tool(id).name} 不通过平台发布`);
  if (!VERSION.test(version)) throw new Error(`版本号不对：${version}（要像 0.9.1 或 0.9.1-test.1）`);
  if (channel !== undefined && !CHANNELS.includes(channel)) throw new Error(`通道只有 ${CHANNELS.join(" / ")}：${channel}`);
}

/**
 * Publishes the program folder `dir` as `id` `version` on `channel`. The same version again with the same files only
 * moves the channel; with other files it is refused (a new version number first).
 * Returns { manifest, existed, uploaded: [sha256], uploadedBytes, channels }.
 */
export async function publish(target, { id, dir, version, notes, channel = "test", log = () => {} }) {
  check(id, version, channel);
  if (!existsSync(dir)) throw new Error(`没有程序文件夹 ${dir}：先打包（npm run package:portable -- --only ${id}）`);
  const built = builtVersion(dir);
  if (built && built !== version) throw new Error(`${dir} 是 ${built} 打的包，现在的版本是 ${version}：先重新打包（npm run package:portable -- --only ${id}）`);
  if (!notes?.trim()) throw new Error(`没有改动说明：在 CHANGELOG.md 里写 ${version} 这一节，或者用 --notes "…"`);
  log(`计算 ${dir} 的清单…`);
  const { manifest, sources } = await buildManifest(id, dir, { version, notes: notes.trim() });
  const existing = await target.readManifest(id, version);
  if (existing && !sameFiles(existing.files, manifest.files)) throw new Error(`${id} ${version} 已经发布过，而且文件不一样：先升版本号（packages/${tool(id).pkg}/package.json 和 CHANGELOG.md），重新打包再发布`);
  const missing = await target.missing([...sources.keys()]);
  const uploadedBytes = missing.reduce((n, sha) => n + statSync(sources.get(sha)).size, 0);
  log(`${manifest.files.length} 个文件，服务器上缺 ${missing.length} 个（${mb(uploadedBytes)}）`);
  if (missing.length) await target.putObjects(missing.map((sha) => ({ sha256: sha, file: sources.get(sha) })), { near: dir });
  if (!existing) await target.writeManifest(manifest);
  const channels = pointChannel(await target.readChannels(), channel, id, version);
  await target.writeChannels(channels);
  return { manifest: existing ?? manifest, existed: !!existing, uploaded: missing, uploadedBytes, channels };
}

/** Points the stable channel at a version already published. */
export async function promote(target, { id, version }) {
  check(id, version);
  if (!(await target.readManifest(id, version))) throw new Error(`${id} ${version} 还没有发布过：先 publish ${id}`);
  const channels = pointChannel(await target.readChannels(), "stable", id, version);
  await target.writeChannels(channels);
  return channels;
}

/** Both channels' versions per tool, the versions published, and the objects stored, as text. */
export async function status(target, { tools = [] } = {}) {
  const channels = { ...emptyChannels(), ...(await target.readChannels()) };
  const versions = await target.listVersions();
  const objects = await target.objectStats();
  const ids = [...new Set([...tools, ...Object.keys(versions), ...Object.keys(channels.stable), ...Object.keys(channels.test)])];
  const rows = [["工具", "稳定", "测试", "已发布"], ...ids.map((id) => [id, channels.stable[id] ?? "-", channels.test[id] ?? "-", (versions[id] ?? []).sort(compareVersions).join(", ") || "-"])];
  // Padded by what a terminal shows: a Chinese character takes two columns.
  const cols = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) >= 0x2e80 ? 2 : 1), 0);
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => cols(r[i]))));
  const lines = rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(width[i] + 2 - cols(c)))).join("").trimEnd());
  lines.push(`文件：${objects.count} 个，${mb(objects.bytes)}`);
  return lines.join("\n");
}

export const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Windows: a file just written can be held a moment (antivirus, indexer, the service reading it); renames retry. */
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

const tmpName = (file) => `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  writeFileSync(tmp, text);
  renameRetry(tmp, file);
}

function readJsonOrNull(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** A platform dir on this machine (--target-dir): tests, and a relay service started here with --platform-dir. */
export class LocalTarget {
  constructor(dir) {
    this.dir = resolve(dir);
    this.where = this.dir;
  }

  objectFile(sha) {
    if (!SHA256.test(sha)) throw new Error(`不是 sha256：${sha}`);
    return join(this.dir, "objects", sha.slice(0, 2), sha);
  }

  async readManifest(id, version) {
    return readJsonOrNull(join(this.dir, "tools", id, `${version}.json`));
  }

  async readChannels() {
    return readJsonOrNull(join(this.dir, "channels.json")) ?? emptyChannels();
  }

  async missing(shas) {
    return shas.filter((sha) => !existsSync(this.objectFile(sha)));
  }

  async putObjects(list) {
    for (const { sha256, file } of list) {
      const to = this.objectFile(sha256);
      mkdirSync(dirname(to), { recursive: true });
      const tmp = tmpName(to);
      copyFileSync(file, tmp);
      // Checked after the copy: what is stored under a sha256 is always that content.
      if ((await hashFile(tmp)) !== sha256) {
        rmSync(tmp, { force: true });
        throw new Error(`${file} 在发布时被改了，重新发布一次`);
      }
      renameRetry(tmp, to);
    }
  }

  async writeManifest(manifest) {
    writeAtomic(join(this.dir, "tools", manifest.tool, `${manifest.version}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async writeChannels(channels) {
    writeAtomic(join(this.dir, "channels.json"), `${JSON.stringify(channels, null, 2)}\n`);
  }

  async listVersions() {
    const tools = join(this.dir, "tools");
    const out = {};
    if (!existsSync(tools)) return out;
    for (const id of readdirSync(tools)) {
      if (!TOOL_ID.test(id) || !statSync(join(tools, id)).isDirectory()) continue;
      out[id] = readdirSync(join(tools, id))
        .filter((n) => n.endsWith(".json") && VERSION.test(n.slice(0, -5)))
        .map((n) => n.slice(0, -5));
    }
    return out;
  }

  async objectStats() {
    const objects = join(this.dir, "objects");
    const files = existsSync(objects) ? walk(objects).filter((f) => SHA256.test(f.split(sep).pop())) : [];
    return { count: files.length, bytes: files.reduce((n, f) => n + statSync(f).size, 0) };
  }
}

/**
 * A platform dir reached through bash (relay-mac.mjs: SSH to the Mac). `run(script, { capture })` runs a bash script
 * there and returns its stdout; `upload(localDir, entries, remoteDir)` unpacks a tar of those entries into remoteDir
 * (created fresh); `root` is the platform dir as the far shell writes it (e.g. "$HOME/Services/amo-relay/platform").
 * Every name put into a script has passed TOOL_ID / VERSION / SHA256.
 */
export class ShellTarget {
  constructor({ run, upload, root, where }) {
    this.run = run;
    this.upload = upload;
    this.root = root;
    this.where = where ?? root;
  }

  sh(script, capture = true) {
    return this.run(`set -e\nPLATFORM="${this.root}"\nmkdir -p "$PLATFORM"\n${script}`, { capture });
  }

  async readManifest(id, version) {
    if (!TOOL_ID.test(id) || !VERSION.test(version)) throw new Error(`工具名或版本号不对：${id} ${version}`);
    const text = await this.sh(`f="$PLATFORM/tools/${id}/${version}.json"; if [ -f "$f" ]; then cat "$f"; fi`);
    return text.trim() ? JSON.parse(text) : null;
  }

  async readChannels() {
    const text = await this.sh(`if [ -f "$PLATFORM/channels.json" ]; then cat "$PLATFORM/channels.json"; fi`);
    return text.trim() ? JSON.parse(text) : emptyChannels();
  }

  async missing(shas) {
    for (const s of shas) if (!SHA256.test(s)) throw new Error(`不是 sha256：${s}`);
    if (!shas.length) return [];
    const text = await this.sh(`cd "$PLATFORM"
while read -r s; do [ -z "$s" ] || [ -f "objects/\${s:0:2}/$s" ] || echo "$s"; done <<'AMO_LIST'
${shas.join("\n")}
AMO_LIST`);
    const there = new Set(shas);
    return text.split(/\r?\n/).filter((s) => there.has(s));
  }

  /**
   * The missing files laid out as objects/ (hard links where the volume allows, else copies) beside the program folder
   * `near` (never inside it, or a later manifest would list them), sent as one tar, checked there against their names and
   * moved into objects/ one by one.
   */
  async putObjects(list, { near }) {
    if (!list.length) return;
    const stageRoot = join(dirname(resolve(near)), `.platform-upload-${randomBytes(4).toString("hex")}`);
    try {
      for (const { sha256, file } of list) {
        if (!SHA256.test(sha256)) throw new Error(`不是 sha256：${sha256}`);
        const to = join(stageRoot, sha256.slice(0, 2), sha256);
        mkdirSync(dirname(to), { recursive: true });
        try {
          linkSync(file, to);
        } catch {
          copyFileSync(file, to);
        }
      }
      const incoming = `incoming-${randomBytes(4).toString("hex")}`;
      await this.upload(stageRoot, readdirSync(stageRoot), `${this.root}/${incoming}`);
      // shasum on the Mac (and in Git Bash); a file that does not match its name is left out and reported.
      await this.sh(
        `IN="$PLATFORM/${incoming}"; bad=0
cd "$IN"
for f in */*; do
  [ -f "$f" ] || continue
  s="\${f#*/}"
  got="$(shasum -a 256 "$f" | cut -d' ' -f1)"
  if [ "$got" != "$s" ]; then echo "damaged in transfer: $s" >&2; bad=1; continue; fi
  mkdir -p "$PLATFORM/objects/\${s:0:2}"
  mv -f "$f" "$PLATFORM/objects/\${s:0:2}/$s"
done
cd "$PLATFORM"; rm -rf "$IN"
[ "$bad" = 0 ]`,
        false,
      );
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  async writeText(rel, text) {
    const tag = randomBytes(4).toString("hex");
    // A quoted heredoc: no expansion; JSON never has a line that is just the delimiter.
    await this.sh(
      `f="$PLATFORM/${rel}"; mkdir -p "$(dirname "$f")"
cat > "$f.tmp-${tag}" <<'AMO_JSON_${tag}'
${text.replace(/\n$/, "")}
AMO_JSON_${tag}
mv -f "$f.tmp-${tag}" "$f"`,
      false,
    );
  }

  async writeManifest(manifest) {
    if (!TOOL_ID.test(manifest.tool) || !VERSION.test(manifest.version)) throw new Error(`工具名或版本号不对：${manifest.tool} ${manifest.version}`);
    await this.writeText(`tools/${manifest.tool}/${manifest.version}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async writeChannels(channels) {
    await this.writeText("channels.json", `${JSON.stringify(channels, null, 2)}\n`);
  }

  async listVersions() {
    const text = await this.sh(`if [ -d "$PLATFORM/tools" ]; then cd "$PLATFORM/tools"; find . -mindepth 2 -maxdepth 2 -type f -name '*.json'; fi`);
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\.\/([^/]+)\/(.+)\.json$/.exec(line.trim());
      if (!m || !TOOL_ID.test(m[1]) || !VERSION.test(m[2])) continue;
      (out[m[1]] ??= []).push(m[2]);
    }
    return out;
  }

  async objectStats() {
    const text = await this.sh(`if [ -d "$PLATFORM/objects" ]; then find "$PLATFORM/objects" -type f | wc -l; du -sk "$PLATFORM/objects" | cut -f1; else echo 0; echo 0; fi`);
    const [count = 0, kb = 0] = text.trim().split(/\s+/).map(Number);
    return { count, bytes: kb * 1024 };
  }
}
