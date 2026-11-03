import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSources, installClaude } from "./claude-install.js";
import { machinePlatform, type InstallFrom, type InstallRunner } from "./tool-mirror.js";

// One fake server for both sides: Anthropic's paths at /official/…, the team server's mirror at /api/platform/mirror/…
// and /platform/mirror/… (Bearer key "k").

interface Fake {
  url: string;
  latest: string;
  exe: Map<string, Buffer>;
  /** Versions the mirror has ready. */
  ready: Set<string>;
  preparing: { version: string; platform: string; done: number; total: number } | null;
  officialDown: boolean;
  mirrorFile404: boolean;
  wrongChecksum: boolean;
  /** Every request: path and its Range. */
  seen: { path: string; range: string | null }[];
  /** Drop the next .zst after n bytes. */
  cutNext: number | null;
  server: Server;
}

const fakes: Fake[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) {
    f.server.closeAllConnections();
    await new Promise((r) => f.server.close(r));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "platform-claude-"));
  dirs.push(d);
  return d;
};

async function fake(): Promise<Fake> {
  const f: Fake = { url: "", latest: "2.1.316", exe: new Map(), ready: new Set(["2.1.316"]), preparing: null, officialDown: false, mirrorFile404: false, wrongChecksum: false, seen: [], cutNext: null, server: null as unknown as Server };
  const exeOf = (v: string) => {
    if (!f.exe.has(v)) f.exe.set(v, Buffer.concat([randomBytes(100_000), Buffer.alloc(100_000, 3)]));
    return f.exe.get(v)!;
  };
  const manifest = (v: string) => ({ version: v, platforms: { "win32-x64": { binary: "claude.exe", checksum: f.wrongChecksum ? "f".repeat(64) : createHash("sha256").update(exeOf(v)).digest("hex"), size: exeOf(v).length } } });
  const sendZst = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, v: string) => {
    const zst = zstdCompressSync(exeOf(v));
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const body = zst.subarray(start);
    res.writeHead(m ? 206 : 200, { "content-length": String(body.length), ...(m ? { "content-range": `bytes ${start}-${zst.length - 1}/${zst.length}` } : {}) });
    if (f.cutNext !== null) {
      res.write(body.subarray(0, f.cutNext));
      f.cutNext = null;
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.end(body);
  };
  f.server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    f.seen.push({ path, range: req.headers.range ?? null });
    const no = () => void (res.writeHead(404, { "content-type": "application/json" }), res.end(JSON.stringify({ message: "没有" })));
    if (path.startsWith("/official/")) {
      if (f.officialDown) return void res.destroy();
      const rest = path.slice("/official/".length).split("/");
      if (rest[0] === "latest") return void res.end(f.latest);
      if (rest[1] === "manifest.json") return void res.end(JSON.stringify(manifest(rest[0]!)));
      if (rest[1] === "win32-x64" && rest[2] === "claude.exe.zst") return sendZst(req, res, rest[0]!);
      return no();
    }
    if (req.headers.authorization !== "Bearer k") return void (res.writeHead(401), res.end("{}"));
    if (path === "/api/platform/mirror/claude-code") {
      const versions = [...f.ready].map((v) => ({ version: v, readyAt: "", platforms: { "win32-x64": { file: "claude.exe.zst", size: zstdCompressSync(exeOf(v)).length, sha256: manifest(v).platforms["win32-x64"].checksum, exeSize: exeOf(v).length } } }));
      return void res.end(JSON.stringify({ official: f.latest, checkedAt: null, versions, preparing: f.preparing }));
    }
    const m = /^\/platform\/mirror\/claude-code\/([^/]+)\/(.+)$/.exec(path);
    if (m && f.ready.has(m[1]!)) {
      if (m[2] === "manifest.json") return void res.end(JSON.stringify(manifest(m[1]!)));
      if (m[2] === "win32-x64/claude.exe.zst" && !f.mirrorFile404) return sendZst(req, res, m[1]!);
    }
    return no();
  });
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  fakes.push(f);
  return f;
}

const runs: { exe: string; args: string[] }[] = [];
const run: InstallRunner = async (exe, args) => {
  runs.push({ exe, args });
  return { ok: true, out: "Claude Code successfully installed!" };
};

const setup = async () => {
  const f = await fake();
  const home = tmp();
  const env = { USERPROFILE: home, PROCESSOR_ARCHITECTURE: "AMD64" };
  const base = { env, account: { server: f.url, key: "k" }, base: `${f.url}/official` };
  const install = (version: string, from: InstallFrom, extra: Record<string, unknown> = {}) => installClaude(version, from, { ...base, downloadsDir: join(home, "dl"), run, retryDelaysMs: [10, 10], ...extra });
  const versionFile = (v: string) => join(home, ".local", "share", "claude", "versions", v);
  return { f, home, env, base, install, versionFile };
};

describe("Claude Code 安装 (claude-install.ts)", () => {
  it("gives both places: the server's newest ready version and Anthropic's latest; says when the server prepares a newer one", async () => {
    const { f, base } = await setup();
    f.latest = "2.1.317";
    f.preparing = { version: "2.1.317", platform: "win32-x64", done: 45, total: 100 };
    const both = await claudeSources(base);
    expect(both).toMatchObject({ platform: "win32-x64", server: { version: "2.1.316" }, official: { version: "2.1.317" } });
    expect(both.server?.size).toBeGreaterThan(0);
    expect(both.preparing).toBe("团队服务器正在准备 2.1.317（45%），下好之后可以从团队服务器装（局域网，更快）。");
    expect(await claudeSources({ ...base, account: null })).toEqual({ platform: "win32-x64", server: null, official: { version: "2.1.317" }, preparing: null });
    expect((await claudeSources({ ...base, account: { server: f.url, key: "wrong" } })).server).toBeNull();
    f.ready.clear();
    expect((await claudeSources(base)).server).toBeNull();
    f.officialDown = true;
    expect(await claudeSources(base)).toMatchObject({ server: null, official: null });
    expect(machinePlatform({ PROCESSOR_ARCHITECTURE: "AMD64", PROCESSOR_ARCHITEW6432: "ARM64" })).toBe("win32-arm64");
    expect(machinePlatform({})).toBe("win32-x64");
  });

  it("downloads from the server, checks it against Anthropic's manifest, puts it in versions and runs install", async () => {
    const { f, home, install, versionFile } = await setup();
    runs.length = 0;
    const phases: string[] = [];
    const done = await install("2.1.316", "server", { onProgress: (p: { phase: string }) => phases.at(-1) !== p.phase && phases.push(p.phase) });
    expect(done).toMatchObject({ version: "2.1.316", from: "server" });
    expect(readFileSync(versionFile("2.1.316")).equals(f.exe.get("2.1.316")!)).toBe(true);
    expect(runs).toEqual([{ exe: versionFile("2.1.316"), args: ["install", "2.1.316"] }]);
    expect(phases).toEqual(["manifest", "downloading", "unpacking", "installing"]);
    // Anthropic's manifest was asked, the file came from the server; nothing left behind.
    expect(f.seen.map((s) => s.path)).toEqual(["/official/2.1.316/manifest.json", "/platform/mirror/claude-code/2.1.316/win32-x64/claude.exe.zst"]);
    expect(readdirSync(join(home, "dl"))).toEqual([]);
    expect(readdirSync(join(home, ".local", "share", "claude", "versions"))).toEqual(["2.1.316"]);
    // Already there and right: only install runs again.
    f.seen.length = 0;
    await install("2.1.316", "server");
    expect(f.seen.map((s) => s.path)).toEqual(["/official/2.1.316/manifest.json"]);
  });

  it("goes on after a break; a server without the file stops and points at the official one, which goes on from the same part", async () => {
    const { f, install, versionFile } = await setup();
    f.cutNext = 40_000;
    await install("2.1.316", "server");
    const zst = f.seen.filter((s) => s.path.endsWith(".zst"));
    expect(zst[0]!.range).toBeNull();
    expect(zst[1]!.range).toMatch(/^bytes=\d+-$/);
    expect(readFileSync(versionFile("2.1.316")).equals(f.exe.get("2.1.316")!)).toBe(true);

    // Not turned to Anthropic by itself (the user, 2026-11-03: the person picks).
    const b = await setup();
    b.f.mirrorFile404 = true;
    await expect(b.install("2.1.316", "server")).rejects.toThrow(/团队服务器上拿不到这个文件了.*也可以点「官方」那一行的按钮从官方下/);
    expect(b.f.seen.map((s) => s.path)).not.toContain("/official/2.1.316/win32-x64/claude.exe.zst");

    // Broken from the server with no tries left: the part stays, and 官方 goes on from it.
    const c = await setup();
    c.f.cutNext = 40_000;
    await expect(c.install("2.1.316", "server", { retryDelaysMs: [] })).rejects.toThrow(/下了的部分留着/);
    const r = await c.install("2.1.316", "official");
    expect(r.from).toBe("official");
    expect(c.f.seen.find((s) => s.path === "/official/2.1.316/win32-x64/claude.exe.zst")?.range).toMatch(/^bytes=[1-9]\d*-$/);
    expect(readFileSync(c.versionFile("2.1.316")).equals(c.f.exe.get("2.1.316")!)).toBe(true);
    await expect(c.install("2.1.316", "server", { account: null })).rejects.toThrow(/没登录团队服务器/);
  });

  it("uses the server's manifest only when Anthropic cannot be reached; installs nothing that does not match", async () => {
    const { f, install, versionFile, home } = await setup();
    f.officialDown = true;
    await install("2.1.316", "server");
    expect(existsSync(versionFile("2.1.316"))).toBe(true);
    await expect(install("2.1.316", "official")).rejects.toThrow(/拿不到 2\.1\.316 的清单/);

    const b = await setup();
    b.f.wrongChecksum = true;
    runs.length = 0;
    await expect(b.install("2.1.316", "server")).rejects.toThrow(/对不上/);
    expect(existsSync(b.versionFile("2.1.316"))).toBe(false);
    expect(readdirSync(join(b.home, "dl"))).toEqual([]);
    expect(runs).toEqual([]);
    expect(home).not.toBe(b.home);
  });

  it("clears other versions' leftovers, replaces an empty placeholder, and says when install fails", async () => {
    const { install, versionFile, home } = await setup();
    mkdirSync(join(home, "dl"), { recursive: true });
    writeFileSync(join(home, "dl", "claude-2.1.300-win32-x64.exe.zst.part"), "old");
    mkdirSync(join(home, ".local", "share", "claude", "versions"), { recursive: true });
    writeFileSync(versionFile("2.1.316"), "");
    const failing: InstallRunner = async () => ({ ok: false, out: "line1\nInstallation failed", reason: "error" });
    await expect(install("2.1.316", "server", { run: failing })).rejects.toThrow(/claude install 没成功（出错）：\nline1\nInstallation failed/);
    expect(readdirSync(join(home, "dl"))).toEqual([]);
    expect(readFileSync(versionFile("2.1.316")).length).toBe(200_000);
  });
});
