import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { resumeDownload } from "@amo-studio/locate/download";
import { RelayClient } from "./client.js";
import { checkMirrorSettings, CLAUDE_CODE_SOURCE, CODEX_SOURCE, DEFAULT_MIRROR_SETTINGS, type MirrorOptions, type MirrorSource, ToolMirror } from "./mirror.js";
import { startRelayServer } from "./server.js";
import { RelayStore } from "./store.js";

// A stand-in for downloads.claude.ai: /latest, /<v>/manifest.json, /<v>/<platform>/claude.exe.zst with Range, and ways to
// break a download part way (cut: the connection drops after n bytes; stall: it stops sending and hangs). The same server
// stands in for npm's registry for Codex: /@openai%2fcodex/latest, /@openai%2fcodex/<v>-<platform> (dist.integrity) and
// /@openai/codex/-/codex-<v>-<platform>.tgz (the build's zst bytes standing in for the .tgz).

interface Build {
  exe: Buffer;
  zst: Buffer;
}

interface Fake {
  base: string;
  latest: string;
  builds: Map<string, Record<string, Build>>;
  /** Range headers seen on .zst requests, in order. */
  ranges: (string | null)[];
  /** The next .zst responses: drop after n bytes, or hang after n bytes. */
  faults: { kind: "cut" | "stall" | "no-range"; after: number }[];
  /** Manifest entries to lie about. */
  wrongChecksum: boolean;
  server: Server;
}

const fakes: Fake[] = [];
const dirs: string[] = [];
const mirrors: ToolMirror[] = [];

afterEach(async () => {
  for (const m of mirrors.splice(0)) await m.close();
  for (const f of fakes.splice(0)) {
    f.server.closeAllConnections();
    await new Promise((r) => f.server.close(r));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "relay-mirror-"));
  dirs.push(d);
  return d;
};

const build = (size = 300_000): Build => {
  // Half random, half repeated: zstd has something to squeeze, and the .zst is still big enough to break part way.
  const exe = Buffer.concat([randomBytes(size / 2), Buffer.alloc(size / 2, 7)]);
  return { exe, zst: zstdCompressSync(exe) };
};

async function fake(versions: Record<string, string[]>, latest: string): Promise<Fake> {
  const f: Fake = { base: "", latest, builds: new Map(), ranges: [], faults: [], wrongChecksum: false, server: null as unknown as Server };
  for (const [v, platforms] of Object.entries(versions)) f.builds.set(v, Object.fromEntries(platforms.map((p) => [p, build()])));
  f.server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/latest") return void res.end(f.latest);
    const m = /^\/([^/]+)\/manifest\.json$/.exec(path);
    if (m) {
      const b = f.builds.get(m[1]!);
      if (!b) return void (res.writeHead(404), res.end());
      const platforms = Object.fromEntries(Object.entries(b).map(([p, x]) => [p, { binary: "claude.exe", checksum: f.wrongChecksum ? "0".repeat(64) : createHash("sha256").update(x.exe).digest("hex"), size: x.exe.length }]));
      return void res.end(JSON.stringify({ version: m[1], manifestSignatureEnforcement: "flag", platforms }));
    }
    if (path === "/@openai%2fcodex/latest") return void res.end(JSON.stringify({ name: "@openai/codex", version: f.latest }));
    const doc = /^\/@openai%2fcodex\/(\d+\.\d+\.\d+)-(win32-[a-z0-9]+)$/.exec(path);
    if (doc) {
      const b = f.builds.get(doc[1]!)?.[doc[2]!];
      if (!b) return void (res.writeHead(404), res.end());
      const integrity = `sha512-${createHash("sha512").update(f.wrongChecksum ? Buffer.from("x") : b.zst).digest("base64")}`;
      return void res.end(JSON.stringify({ name: "@openai/codex", version: `${doc[1]}-${doc[2]}`, dist: { integrity, tarball: `${f.base}/@openai/codex/-/codex-${doc[1]}-${doc[2]}.tgz` } }));
    }
    const z = /^\/([^/]+)\/([^/]+)\/claude\.exe\.zst$/.exec(path) ?? /^\/@openai\/codex\/-\/codex-(\d+\.\d+\.\d+)-(win32-[a-z0-9]+)\.tgz$/.exec(path);
    const file = z ? f.builds.get(z[1]!)?.[z[2]!]?.zst : undefined;
    if (!file) return void (res.writeHead(404), res.end());
    const range = req.headers.range ?? null;
    f.ranges.push(range);
    const fault = f.faults.shift();
    let start = 0;
    const r = range && fault?.kind !== "no-range" ? /^bytes=(\d+)-$/.exec(range) : null;
    if (r) start = Number(r[1]);
    if (start >= file.length && r) return void (res.writeHead(416, { "content-range": `bytes */${file.length}` }), res.end());
    const body = file.subarray(start);
    res.writeHead(r ? 206 : 200, { "content-length": String(body.length), "accept-ranges": "bytes", ...(r ? { "content-range": `bytes ${start}-${file.length - 1}/${file.length}` } : {}) });
    if (!fault || fault.kind === "no-range") return void res.end(body);
    res.write(body.subarray(0, fault.after));
    if (fault.kind === "cut") setTimeout(() => res.socket?.destroy(), 20);
    // stall: nothing more; the client gives up
  });
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.base = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  fakes.push(f);
  return f;
}

const mirror = (dir: string, f: Fake, extra: Partial<MirrorOptions> = {}, source: MirrorSource = CLAUDE_CODE_SOURCE) => {
  const m = new ToolMirror(source, { dir, base: f.base, retryDelaysMs: [10, 10, 10], stallMs: 300, ...extra });
  mirrors.push(m);
  return m;
};

describe("Claude Code 镜像 (mirror.ts)", () => {
  it("downloads the latest .zst, checks it against the manifest and hands it out; a second check downloads nothing", async () => {
    const f = await fake({ "2.1.316": ["win32-x64", "win32-arm64"] }, "2.1.316");
    const dir = tmp();
    const m = mirror(dir, f);
    await m.checkNow();
    const view = m.adminView();
    expect(view.status).toMatchObject({ state: "idle", official: "2.1.316", error: null, progress: null });
    expect(view.versions).toHaveLength(1);
    // x64 only by default (the user, 2026-11-03).
    expect(Object.keys(view.versions[0]!.platforms)).toEqual(["win32-x64"]);
    const x64 = f.builds.get("2.1.316")!["win32-x64"]!;
    expect(view.versions[0]!.platforms["win32-x64"]).toEqual({ file: "claude.exe.zst", size: x64.zst.length, sha256: createHash("sha256").update(x64.exe).digest("hex"), exeSize: x64.exe.length });
    const file = m.file("2.1.316", "win32-x64")!;
    expect(readFileSync(file.path).equals(x64.zst)).toBe(true);
    expect(m.file("2.1.316", "win32-arm64")).toBeNull();
    expect(m.file("../2.1.316", "win32-x64")).toBeNull();
    expect(JSON.parse(readFileSync(m.metaFile("2.1.316", "manifest.json")!, "utf8")).version).toBe("2.1.316");
    expect(m.metaFile("2.1.316", "index.json")).toBeNull();
    expect(m.platformView()).toMatchObject({ official: "2.1.316", preparing: null, versions: [{ version: "2.1.316" }] });
    await m.checkNow();
    expect(f.ranges).toHaveLength(1);
    // A restart reads what is ready from index.json.
    const again = mirror(dir, f);
    expect(again.adminView().versions.map((v) => v.version)).toEqual(["2.1.316"]);
    expect(again.adminView().status.official).toBe("2.1.316");
  });

  it("goes on from where a broken download stopped (Range), also after a stall", async () => {
    const f = await fake({ "2.1.316": ["win32-x64"] }, "2.1.316");
    f.faults.push({ kind: "cut", after: 50_000 }, { kind: "stall", after: 30_000 });
    const m = mirror(tmp(), f);
    await m.checkNow();
    expect(m.adminView().status.error).toBeNull();
    expect(m.file("2.1.316", "win32-x64")).not.toBeNull();
    expect(f.ranges[0]).toBeNull();
    expect(f.ranges[1]).toMatch(/^bytes=\d+-$/);
    const firstResume = Number(/\d+/.exec(f.ranges[1]!)![0]);
    expect(firstResume).toBeGreaterThan(0);
    expect(Number(/\d+/.exec(f.ranges[2]!)![0])).toBeGreaterThan(firstResume);
  });

  it("throws away a file that does not match the manifest, and says so", async () => {
    const f = await fake({ "2.1.316": ["win32-x64"] }, "2.1.316");
    f.wrongChecksum = true;
    const dir = tmp();
    const m = mirror(dir, f, { retryDelaysMs: [10] });
    await m.checkNow();
    const view = m.adminView();
    expect(view.versions).toEqual([]);
    expect(view.status.error).toMatch(/对不上/);
    expect(readdirSync(join(dir, "claude-code", "2.1.316", "win32-x64"))).toEqual([]);
    // Each try downloaded the whole file again.
    expect(f.ranges).toEqual([null, null]);
  });

  it("keeps the newest N ready versions", async () => {
    const f = await fake({ "2.1.9": ["win32-x64"], "2.1.10": ["win32-x64"], "2.1.11": ["win32-x64"] }, "2.1.9");
    const dir = tmp();
    const m = mirror(dir, f);
    m.saveSettings({ keep: 2 });
    for (const v of ["2.1.9", "2.1.10", "2.1.11"]) {
      f.latest = v;
      await m.checkNow();
    }
    expect(m.adminView().versions.map((v) => v.version)).toEqual(["2.1.11", "2.1.10"]);
    expect(existsSync(join(dir, "claude-code", "2.1.9"))).toBe(false);
    expect(m.file("2.1.9", "win32-x64")).toBeNull();
  });

  it("checks and keeps its settings; switched off it does not check", async () => {
    expect(checkMirrorSettings({})).toEqual(DEFAULT_MIRROR_SETTINGS);
    expect(checkMirrorSettings({ platforms: ["win32-arm64", "win32-x64"], everyMinutes: "30" })).toMatchObject({ platforms: ["win32-x64", "win32-arm64"], everyMinutes: 30 });
    expect(() => checkMirrorSettings({ everyMinutes: 5 })).toThrow(/10 到 1440/);
    expect(() => checkMirrorSettings({ platforms: [] })).toThrow(/至少选一个/);
    expect(() => checkMirrorSettings({ platforms: ["linux-x64"] })).toThrow(/只能是/);
    expect(() => checkMirrorSettings({ keep: 0 })).toThrow(/1 到 10/);
    const f = await fake({ "2.1.316": ["win32-x64"] }, "2.1.316");
    const dir = tmp();
    const m = mirror(dir, f);
    m.saveSettings({ enabled: false, everyMinutes: 120 });
    expect(m.adminView().status.state).toBe("off");
    await expect(m.checkNow()).rejects.toThrow(/镜像关着/);
    expect(mirror(dir, f).settings()).toMatchObject({ enabled: false, everyMinutes: 120 });
    writeFileSync(join(dir, "settings.json"), "{ not json");
    expect(mirror(dir, f).settings()).toEqual(DEFAULT_MIRROR_SETTINGS);
  });

  it("says when Anthropic cannot be reached, and keeps what it has", async () => {
    const f = await fake({ "2.1.316": ["win32-x64"] }, "2.1.316");
    const m = mirror(tmp(), f);
    await m.checkNow();
    f.latest = "<html>blocked</html>";
    await m.checkNow();
    expect(m.adminView().status.error).toMatch(/不像版本号/);
    expect(m.adminView().versions).toHaveLength(1);
  });
});

describe("Codex 镜像 (mirror.ts, CODEX_SOURCE)", () => {
  it("downloads npm's win32-x64 package of the latest, checks its sha512 and hands it out; its settings are its own", async () => {
    const f = await fake({ "0.166.0": ["win32-x64", "win32-arm64"] }, "0.166.0");
    f.faults.push({ kind: "cut", after: 40_000 });
    const dir = tmp();
    const claude = mirror(dir, f);
    claude.saveSettings({ keep: 5 });
    const m = mirror(dir, f, {}, CODEX_SOURCE);
    expect(m.settings().keep).toBe(3);
    await m.checkNow();
    const view = m.adminView();
    expect(view).toMatchObject({ tool: "codex", name: "Codex", status: { state: "idle", official: "0.166.0", error: null } });
    const tgz = f.builds.get("0.166.0")!["win32-x64"]!.zst;
    expect(view.versions[0]!.platforms).toEqual({ "win32-x64": { file: "codex-0.166.0-win32-x64.tgz", size: tgz.length, integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` } });
    expect(readFileSync(m.file("0.166.0", "win32-x64")!.path).equals(tgz)).toBe(true);
    // It went on after the cut.
    expect(f.ranges[1]).toMatch(/^bytes=\d+-$/);
    expect(existsSync(join(dir, "codex", "0.166.0", "win32-x64", "codex-0.166.0-win32-x64.tgz"))).toBe(true);
    expect(m.metaFile("0.166.0", "manifest.json")).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toMatchObject({ "claude-code": { keep: 5 } });
    m.saveSettings({ keep: 2 });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toMatchObject({ "claude-code": { keep: 5 }, codex: { keep: 2 } });
  });

  it("throws away a package whose sha512 is not npm's", async () => {
    const f = await fake({ "0.166.0": ["win32-x64"] }, "0.166.0");
    f.wrongChecksum = true;
    const m = mirror(tmp(), f, { retryDelaysMs: [] }, CODEX_SOURCE);
    await m.checkNow();
    expect(m.adminView().versions).toEqual([]);
    expect(m.adminView().status.error).toMatch(/sha512 对不上/);
  });
});

describe("resumeDownload (locate/download.ts)", () => {
  it("starts over when the server ignores Range, and is done at once when the file is already whole", async () => {
    const f = await fake({ "1.0.0": ["win32-x64"] }, "1.0.0");
    const zst = f.builds.get("1.0.0")!["win32-x64"]!.zst;
    const url = `${f.base}/1.0.0/win32-x64/claude.exe.zst`;
    const part = join(tmp(), "x.part");
    writeFileSync(part, zst.subarray(0, 1000));
    f.faults.push({ kind: "no-range", after: 0 });
    expect(await resumeDownload(url, part)).toEqual({ size: zst.length });
    expect(readFileSync(part).equals(zst)).toBe(true);
    expect(await resumeDownload(url, part)).toEqual({ size: zst.length });
    expect(f.ranges.at(-1)).toBe(`bytes=${zst.length}-`);
  });

  it("throws with the server's status for a missing file", async () => {
    const f = await fake({}, "1.0.0");
    await expect(resumeDownload(`${f.base}/9.9.9/win32-x64/claude.exe.zst`, join(tmp(), "y.part"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("the service's mirror routes (server.ts)", () => {
  it("admin page reads and sets it; people signed in get the list, the manifest and the .zst with Range", async () => {
    const f = await fake({ "2.1.316": ["win32-x64"] }, "2.1.316");
    const m = mirror(tmp(), f);
    const store = new RelayStore(":memory:");
    const codex = mirror(m.dir, f, {}, CODEX_SOURCE);
    const server = await startRelayServer({ store, host: "127.0.0.1", port: 0, mirrors: { "claude-code": m, codex } });
    try {
      store.setAdminPassword("admin-pw");
      const admin = (method: string, path: string, body?: unknown) =>
        fetch(`${server.url}${path}`, { method, headers: { "content-type": "application/json", "x-amo-admin": "admin-pw" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
      expect((await admin("POST", "/api/admin/mirror/settings", { tool: "claude-code", everyMinutes: 5 })).status).toBe(400);
      expect((await admin("POST", "/api/admin/mirror/settings", { tool: "claude-code", everyMinutes: 30 })).body.settings.everyMinutes).toBe(30);
      expect((await admin("POST", "/api/admin/mirror/settings", { tool: "codex", enabled: false })).body.settings.enabled).toBe(false);
      expect(codex.settings().everyMinutes).toBe(60);
      expect((await admin("POST", "/api/admin/mirror/check", { tool: "codex" })).status).toBe(409);
      expect((await admin("POST", "/api/admin/mirror/check", { tool: "nope" })).status).toBe(404);
      expect((await admin("POST", "/api/admin/mirror/check", { tool: "claude-code" })).status).toBe(200);
      await m.checkNow();
      const view = (await admin("GET", "/api/admin/mirror")).body;
      expect(view.tools.map((t: { tool: string }) => t.tool)).toEqual(["claude-code", "codex"]);
      expect(view.tools[0].versions[0].version).toBe("2.1.316");
      expect(view.tools[1].status.state).toBe("off");

      const { key } = await new RelayClient(server.url).register("程序老李", "pw-li");
      const get = (path: string, headers: Record<string, string> = {}) => fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${key}`, ...headers } });
      expect((await fetch(`${server.url}/api/platform/mirror/claude-code`)).status).toBe(401);
      const list = (await (await get("/api/platform/mirror/claude-code")).json()) as { official: string; versions: { version: string }[] };
      expect(list.official).toBe("2.1.316");
      expect((await (await get("/platform/mirror/claude-code/2.1.316/manifest.json")).json()).version).toBe("2.1.316");
      const zst = f.builds.get("2.1.316")!["win32-x64"]!.zst;
      const whole = await get("/platform/mirror/claude-code/2.1.316/win32-x64/claude.exe.zst");
      expect(whole.status).toBe(200);
      expect(Buffer.from(await whole.arrayBuffer()).equals(zst)).toBe(true);
      const part = await get("/platform/mirror/claude-code/2.1.316/win32-x64/claude.exe.zst", { range: "bytes=100-" });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes 100-${zst.length - 1}/${zst.length}`);
      expect(Buffer.from(await part.arrayBuffer()).equals(zst.subarray(100))).toBe(true);
      expect((await get("/platform/mirror/claude-code/2.1.316/win32-x64/claude.exe.zst", { range: `bytes=${zst.length}-` })).status).toBe(416);
      expect((await get("/platform/mirror/claude-code/2.1.316/win32-arm64/claude.exe.zst")).status).toBe(404);
      expect((await get("/platform/mirror/claude-code/2.1.316/win32-x64/other.zst")).status).toBe(404);
      expect((await get("/platform/mirror/claude-code/2.1.300/manifest.json")).status).toBe(404);
      expect((await get("/api/platform/mirror/codex")).status).toBe(200);
      expect((await get("/api/platform/mirror/other")).status).toBe(404);
      // The platform's own resume goes through the service the same way.
      const dest = join(tmp(), "c.part");
      writeFileSync(dest, zst.subarray(0, 5000));
      expect(await resumeDownload(`${server.url}/platform/mirror/claude-code/2.1.316/win32-x64/claude.exe.zst`, dest, { headers: { authorization: `Bearer ${key}` } })).toEqual({ size: zst.length });
      expect(readFileSync(dest).equals(zst)).toBe(true);
    } finally {
      await server.close();
      store.close();
    }
  });

  it("answers 404 when the service has no mirror", async () => {
    const store = new RelayStore(":memory:");
    const server = await startRelayServer({ store, host: "127.0.0.1", port: 0 });
    try {
      const { key } = await new RelayClient(server.url).register("程序老李", "pw-li");
      expect((await fetch(`${server.url}/api/platform/mirror/claude-code`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(404);
    } finally {
      await server.close();
      store.close();
    }
  });
});
