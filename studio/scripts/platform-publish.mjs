// Publishing the AMO tools for the platform (2026-10-28, plans/amo-lan-platform.md 「第一版的接口约定」): the core of
// relay-mac.mjs publish / promote / platform-status, kept apart from SSH so it can be tested and pointed at a local folder.
// The platform dir (on the Mac $ROOT/platform, next to app/ and data/; the relay service reads it, packages/relay/src/platform.ts):
//   objects/<sha256 first two>/<sha256>   file contents by sha256, each stored once — as it is, or
//   objects/<sha256 first two>/<sha256>.gz   gzipped (2026-10-29), when that makes it at least 10% smaller; the sha256 is
//                                         always the original's. The service sends the .gz as Content-Encoding: gzip,
//                                         or unpacks it for a client that does not take gzip.
//   tools/<tool>/<version>.json           { tool, name, version, builtAt, exe, runtime, notes, files: [{ path, size, sha256 }] }
//                                         (runtime: the Electron version, 2026-10-29; only folders package-portable built
//                                         with --platform are published, so every tool's Electron files are the same)
//   channels.json                         { "stable": { "studio": "0.9.0", … }, "test": { … } }
// A publish: hash the program folder (release/<Name>/, from package-portable.mjs), ask the target which objects it lacks,
// send only those, then write the manifest, then the channel — each step only after the one it depends on, each file
// written beside its place and renamed in, so a reader never sees a manifest whose files are not there yet. Objects are
// compressed here (Node zlib) before they are sent: installing Studio fetched 375 MB, its exe alone 246 MB → 109 MB.
// platformCompress (relay-mac.mjs platform-compress) does the same for objects stored as they are before that.
// Two targets: LocalTarget (a folder on this machine: tests, or a relay service started here with --platform-dir) and
// ShellTarget (bash on the far side of a runner: relay-mac.mjs gives it SSH to the Mac).
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { tool } from "./amo-tools.mjs";

// The same patterns as the service (packages/relay/src/platform.ts).
export const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const CHANNELS = ["test", "stable"];
/** An object is stored gzipped only when that is smaller than this share of it (the rest are already packed: images, fonts…). */
export const GZIP_WORTH = 0.9;
/** gzip -6: Studio's exe 246 MB → 109 MB in 5 s here; -1 gives 118 MB, -9 109 MB in 7.6 s. */
export const GZIP_LEVEL = 6;
/** An object's name in objects/<first two>/: the sha256, plus .gz when it is stored gzipped. */
export const OBJECT_NAME = /^([0-9a-f]{64})(\.gz)?$/;

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

/** A stream step that hashes what passes through it and counts it. */
function hasher() {
  const h = createHash("sha256");
  const t = new Transform({
    transform(chunk, _enc, done) {
      h.update(chunk);
      t.bytes += chunk.length;
      done(null, chunk);
    },
  });
  t.bytes = 0;
  t.digest = () => h.digest("hex");
  return t;
}

/**
 * Gzips `file` into `to` and says whether it is worth keeping: { sha256 (of what was read), size, gzSize, worth }. When
 * it is not, `to` is removed. The caller checks `sha256` against the name it stores the result under.
 */
export async function gzipFile(file, to) {
  const h = hasher();
  await pipeline(createReadStream(file), h, createGzip({ level: GZIP_LEVEL }), createWriteStream(to));
  const gzSize = statSync(to).size;
  const worth = gzSize < h.bytes * GZIP_WORTH;
  if (!worth) rmSync(to, { force: true });
  return { sha256: h.digest(), size: h.bytes, gzSize, worth };
}

/** sha256 of a gzip file's content once unpacked. */
export async function gunzipHash(file) {
  const h = hasher();
  await pipeline(createReadStream(file), createGunzip(), h, async function* (src) {
    for await (const _ of src);
  });
  return h.digest();
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

function appPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "resources", "app", "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The version package-portable wrote into the program folder (resources/app/package.json), or null. */
export function builtVersion(dir) {
  return appPackage(dir)?.version ?? null;
}

/**
 * How package-portable built the folder (resources/app/package.json "amoBuild", 2026-10-29): { mode: "platform" |
 * "portable", runtime: the Electron version }, or null for a folder built before that (portable, exe icons written).
 */
export function builtFor(dir) {
  const b = appPackage(dir)?.amoBuild;
  return b && typeof b === "object" && typeof b.mode === "string" ? { mode: b.mode, runtime: typeof b.runtime === "string" ? b.runtime : null } : null;
}

/**
 * The manifest of a program folder, and where each object's content is on this machine. `builtAt` is when the folder
 * was written (its newest file), in ms. `runtime` (2026-10-29) is the Electron version it was built with.
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
  const runtime = builtFor(dir)?.runtime;
  return { manifest: { tool: id, name: t.name, version, builtAt, exe, ...(runtime ? { runtime } : {}), notes, files }, sources };
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
 * Returns { manifest, existed, uploaded: [sha256], uploadedBytes (their size), sentBytes (as stored: gzipped or not), channels }.
 */
export async function publish(target, { id, dir, version, notes, channel = "test", log = () => {} }) {
  check(id, version, channel);
  if (!existsSync(dir)) throw new Error(`没有程序文件夹 ${dir}：先打包（npm run package:platform -- --only ${id}）`);
  // Only folders built for the platform (2026-10-29): a portable one has the tool's icon written into its exe, so its
  // Electron files are not the same as the other tools' and every machine would download and keep them again.
  const mode = builtFor(dir)?.mode ?? "portable";
  if (mode !== "platform") throw new Error(`${dir} 是 ${mode} 模式打的包（exe 里写了图标，各工具的 Electron 文件不一样，平台没法共用）：先用平台模式打包（npm run package:platform -- --only ${id}），再发布`);
  const built = builtVersion(dir);
  if (built && built !== version) throw new Error(`${dir} 是 ${built} 打的包，现在的版本是 ${version}：先重新打包（npm run package:platform -- --only ${id}）`);
  if (!notes?.trim()) throw new Error(`没有改动说明：在 CHANGELOG.md 里写 ${version} 这一节，或者用 --notes "…"`);
  log(`计算 ${dir} 的清单…`);
  const { manifest, sources } = await buildManifest(id, dir, { version, notes: notes.trim() });
  const existing = await target.readManifest(id, version);
  if (existing && !sameFiles(existing.files, manifest.files)) throw new Error(`${id} ${version} 已经发布过，而且文件不一样：先升版本号（packages/${tool(id).pkg}/package.json 和 CHANGELOG.md），重新打包再发布`);
  const missing = await target.missing([...sources.keys()]);
  const uploadedBytes = missing.reduce((n, sha) => n + statSync(sources.get(sha)).size, 0);
  log(`${manifest.files.length} 个文件，服务器上缺 ${missing.length} 个（${mb(uploadedBytes)}）`);
  const sentBytes = missing.length ? (await target.putObjects(missing.map((sha) => ({ sha256: sha, file: sources.get(sha) })), { near: dir })).bytes : 0;
  if (!existing) await target.writeManifest(manifest);
  const channels = pointChannel(await target.readChannels(), channel, id, version);
  await target.writeChannels(channels);
  return { manifest: existing ?? manifest, existed: !!existing, uploaded: missing, uploadedBytes, sentBytes, channels };
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
  lines.push(`文件：${objects.count} 个，${mb(objects.bytes)}（压缩存放的 ${objects.gz} 个）`);
  return lines.join("\n");
}

/**
 * Gzips the objects stored as they are (published before 2026-10-29), each only when worth it; safe to run while the
 * service hands them out, and again (what is done is skipped). Returns { files, compressed, damaged, before, after }.
 */
export async function platformCompress(target, { log = () => {} } = {}) {
  return target.compressObjects({ log });
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

  /** Stored either way counts. */
  async missing(shas) {
    return shas.filter((sha) => !existsSync(this.objectFile(sha)) && !existsSync(`${this.objectFile(sha)}.gz`));
  }

  /** Returns { bytes }: what was stored, gzipped or not. */
  async putObjects(list) {
    let bytes = 0;
    for (const { sha256, file } of list) {
      const to = this.objectFile(sha256);
      mkdirSync(dirname(to), { recursive: true });
      // Checked as it is read: what is stored under a sha256 is always that content.
      const changed = () => new Error(`${file} 在发布时被改了，重新发布一次`);
      const gzTmp = tmpName(`${to}.gz`);
      const gz = await gzipFile(file, gzTmp).catch((err) => {
        rmSync(gzTmp, { force: true });
        throw err;
      });
      if (gz.sha256 !== sha256) {
        rmSync(gzTmp, { force: true });
        throw changed();
      }
      if (gz.worth) {
        renameRetry(gzTmp, `${to}.gz`);
        bytes += gz.gzSize;
        continue;
      }
      const tmp = tmpName(to);
      copyFileSync(file, tmp);
      if ((await hashFile(tmp)) !== sha256) {
        rmSync(tmp, { force: true });
        throw changed();
      }
      renameRetry(tmp, to);
      bytes += gz.size;
    }
    return { bytes };
  }

  /**
   * platform-compress: every object stored as it is gzipped beside it when that is worth it (GZIP_WORTH), checked by
   * unpacking it again, renamed in, and only then the original removed — the service always finds one or the other.
   * Returns { files, compressed, damaged, before, after } (bytes of those objects before and after).
   */
  async compressObjects({ log = () => {} } = {}) {
    const objects = join(this.dir, "objects");
    const r = { files: 0, compressed: 0, damaged: 0, before: 0, after: 0 };
    const plain = existsSync(objects) ? walk(objects).filter((f) => SHA256.test(f.split(sep).pop())) : [];
    for (const file of plain) {
      const sha = file.split(sep).pop();
      const size = statSync(file).size;
      r.files++;
      r.before += size;
      if (r.files % 500 === 0) log(`… ${r.files} / ${plain.length}`);
      // Left by a run that stopped between the rename and the delete.
      if (existsSync(`${file}.gz`)) {
        rmSync(file, { force: true });
        r.after += statSync(`${file}.gz`).size;
        r.compressed++;
        continue;
      }
      const tmp = tmpName(`${file}.gz`);
      const gz = await gzipFile(file, tmp);
      if (gz.sha256 !== sha || (gz.worth && (await gunzipHash(tmp)) !== sha)) {
        rmSync(tmp, { force: true });
        log(`没压缩（内容和名字对不上）：${sha}`);
        r.damaged++;
        r.after += size;
        continue;
      }
      if (!gz.worth) {
        r.after += size;
        continue;
      }
      renameRetry(tmp, `${file}.gz`);
      rmSync(file, { force: true });
      r.compressed++;
      r.after += gz.gzSize;
    }
    return r;
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
    const files = existsSync(objects) ? walk(objects).filter((f) => OBJECT_NAME.test(f.split(sep).pop())) : [];
    return { count: files.length, gz: files.filter((f) => f.endsWith(".gz")).length, bytes: files.reduce((n, f) => n + statSync(f).size, 0) };
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
while read -r s; do [ -z "$s" ] || [ -f "objects/\${s:0:2}/$s" ] || [ -f "objects/\${s:0:2}/$s.gz" ] || echo "$s"; done <<'AMO_LIST'
${shas.join("\n")}
AMO_LIST`);
    const there = new Set(shas);
    return text.split(/\r?\n/).filter((s) => there.has(s));
  }

  /**
   * The missing files laid out as objects/ (gzipped when worth it, else hard links where the volume allows, else
   * copies) beside the program folder `near` (never inside it, or a later manifest would list them), sent as one tar,
   * checked there against their names and moved into objects/ one by one.
   */
  async putObjects(list, { near }) {
    if (!list.length) return { bytes: 0 };
    const stageRoot = join(dirname(resolve(near)), `.platform-upload-${randomBytes(4).toString("hex")}`);
    let bytes = 0;
    try {
      for (const { sha256, file } of list) {
        if (!SHA256.test(sha256)) throw new Error(`不是 sha256：${sha256}`);
        const to = join(stageRoot, sha256.slice(0, 2), sha256);
        mkdirSync(dirname(to), { recursive: true });
        const gz = await gzipFile(file, `${to}.gz`);
        if (gz.sha256 !== sha256) throw new Error(`${file} 在发布时被改了，重新发布一次`);
        bytes += gz.worth ? gz.gzSize : gz.size;
        if (gz.worth) continue;
        try {
          linkSync(file, to);
        } catch {
          copyFileSync(file, to);
        }
      }
      const incoming = `incoming-${randomBytes(4).toString("hex")}`;
      await this.upload(stageRoot, readdirSync(stageRoot), `${this.root}/${incoming}`);
      // shasum on the Mac (and in Git Bash), of the content unpacked for a .gz; a file that does not match its name is
      // left out and reported.
      await this.sh(
        `IN="$PLATFORM/${incoming}"; bad=0
cd "$IN"
for f in */*; do
  [ -f "$f" ] || continue
  n="\${f#*/}"; s="\${n%.gz}"
  if [ "$n" = "$s" ]; then got="$(shasum -a 256 "$f" | cut -d' ' -f1)"; else got="$(gzip -dc "$f" | shasum -a 256 | cut -d' ' -f1)"; fi
  if [ "$got" != "$s" ]; then echo "damaged in transfer: $s" >&2; bad=1; continue; fi
  mkdir -p "$PLATFORM/objects/\${s:0:2}"
  mv -f "$f" "$PLATFORM/objects/\${s:0:2}/$n"
done
cd "$PLATFORM"; rm -rf "$IN"
[ "$bad" = 0 ]`,
        false,
      );
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
    return { bytes };
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
    const text = await this.sh(`if [ -d "$PLATFORM/objects" ]; then find "$PLATFORM/objects" -type f ! -name '*.tmp-*' | wc -l; find "$PLATFORM/objects" -type f -name '*.gz' | wc -l; du -sk "$PLATFORM/objects" | cut -f1; else echo 0; echo 0; echo 0; fi`);
    const [count = 0, gz = 0, kb = 0] = text.trim().split(/\s+/).map(Number);
    return { count, gz, bytes: kb * 1024 };
  }

  /**
   * platform-compress on the far side (macOS: bash 3.2, BSD tools — gzip, shasum, wc): each object stored as it is
   * gzipped to a temp file, checked by unpacking it against its name, renamed to <sha256>.gz when worth it (GZIP_WORTH),
   * and only then the original removed, so the service always finds one or the other. Progress goes to stderr.
   */
  async compressObjects() {
    const text = await this.sh(`cd "$PLATFORM"; mkdir -p objects
files=0; compressed=0; damaged=0; before=0; after=0; tmp=""
# A run that stops (disk full, the connection drops) leaves no temp file behind.
trap 'rm -f "$tmp"' EXIT
total=$(find objects -type f | grep -cE '/[0-9a-f]{64}$' || true)
for f in objects/*/*; do
  [ -f "$f" ] || continue
  s="\${f##*/}"
  case "$s" in *[!0-9a-f]*) continue ;; esac
  [ \${#s} -eq 64 ] || continue
  size=$(wc -c < "$f" | tr -d ' ')
  files=$((files + 1)); before=$((before + size))
  if [ $((files % 500)) -eq 0 ]; then echo "… $files / $total" >&2; fi
  if [ -f "$f.gz" ]; then
    rm -f "$f"; compressed=$((compressed + 1)); after=$((after + $(wc -c < "$f.gz" | tr -d ' '))); continue
  fi
  tmp="$f.gz.tmp-$$"
  gzip -${GZIP_LEVEL} -c "$f" > "$tmp"
  got="$(gzip -dc "$tmp" | shasum -a 256 | cut -d' ' -f1)"
  if [ "$got" != "$s" ]; then
    echo "not compressed, its content does not match its name: $s" >&2; rm -f "$tmp"; damaged=$((damaged + 1)); after=$((after + size)); continue
  fi
  gz=$(wc -c < "$tmp" | tr -d ' ')
  if [ $((gz * 10)) -lt $((size * ${Math.round(GZIP_WORTH * 10)})) ]; then
    mv -f "$tmp" "$f.gz"; rm -f "$f"; compressed=$((compressed + 1)); after=$((after + gz))
  else
    rm -f "$tmp"; after=$((after + size))
  fi
done
echo "AMO_RESULT $files $compressed $damaged $before $after"`);
    const m = /AMO_RESULT (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(text);
    if (!m) throw new Error(`platform-compress 没有正常结束：${text.trim().slice(-500)}`);
    const [files, compressed, damaged, before, after] = m.slice(1).map(Number);
    return { files, compressed, damaged, before, after };
  }
}
