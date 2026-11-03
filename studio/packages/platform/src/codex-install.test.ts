import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSources, installCodex, isStandaloneCodex } from "./codex-install.js";
import type { InstallFrom, InstallRunner } from "./tool-mirror.js";

// One fake server for both sides: npm's registry at /npm/…, the team server's mirror at /api/platform/mirror/codex and
// /platform/mirror/codex/… (Bearer key "k"). The "platform package" is random bytes standing in for the .tgz.

interface Fake {
  url: string;
  latest: string;
  tgz: Map<string, Buffer>;
  ready: Set<string>;
  npmDown: boolean;
  wrongIntegrity: boolean;
  seen: { path: string; range: string | null }[];
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
  const d = mkdtempSync(join(tmpdir(), "platform-codex-"));
  dirs.push(d);
  return d;
};

const integrityOf = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

async function fake(): Promise<Fake> {
  const f: Fake = { url: "", latest: "0.166.0", tgz: new Map(), ready: new Set(["0.166.0"]), npmDown: false, wrongIntegrity: false, seen: [], cutNext: null, server: null as unknown as Server };
  const tgzOf = (v: string) => {
    if (!f.tgz.has(v)) f.tgz.set(v, randomBytes(200_000));
    return f.tgz.get(v)!;
  };
  const send = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, file: Buffer) => {
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const body = file.subarray(start);
    res.writeHead(m ? 206 : 200, { "content-length": String(body.length), ...(m ? { "content-range": `bytes ${start}-${file.length - 1}/${file.length}` } : {}) });
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
    if (path.startsWith("/npm/")) {
      if (f.npmDown) return void res.destroy();
      if (path === "/npm/@openai%2fcodex/latest") return void res.end(JSON.stringify({ version: f.latest }));
      const doc = /^\/npm\/@openai%2fcodex\/(.+)-win32-x64$/.exec(path);
      if (doc) return void res.end(JSON.stringify({ version: `${doc[1]}-win32-x64`, dist: { integrity: f.wrongIntegrity ? integrityOf(Buffer.from("x")) : integrityOf(tgzOf(doc[1]!)) } }));
      const t = /^\/npm\/@openai\/codex\/-\/codex-(.+)-win32-x64\.tgz$/.exec(path);
      if (t) return send(req, res, tgzOf(t[1]!));
      return no();
    }
    if (req.headers.authorization !== "Bearer k") return void (res.writeHead(401), res.end("{}"));
    if (path === "/api/platform/mirror/codex") {
      const versions = [...f.ready].map((v) => ({ version: v, readyAt: "", platforms: { "win32-x64": { file: `codex-${v}-win32-x64.tgz`, size: tgzOf(v).length, integrity: integrityOf(tgzOf(v)) } } }));
      return void res.end(JSON.stringify({ official: f.latest, checkedAt: null, versions, preparing: null }));
    }
    const m = /^\/platform\/mirror\/codex\/([^/]+)\/win32-x64\/codex-(.+)-win32-x64\.tgz$/.exec(path);
    if (m && f.ready.has(m[1]!)) return send(req, res, tgzOf(m[1]!));
    return no();
  });
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  fakes.push(f);
  return f;
}

const setup = async () => {
  const f = await fake();
  const home = tmp();
  const env = { USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"), PROCESSOR_ARCHITECTURE: "AMD64" };
  const base = { env, account: { server: f.url, key: "k" }, registry: `${f.url}/npm` };
  const runs: { exe: string; args: string[]; cached?: Buffer }[] = [];
  const run: InstallRunner = async (exe, args) => {
    runs.push({ exe, args, ...(args[0] === "cache" ? { cached: readFileSync(args[2]!) } : {}) });
    return { ok: true, out: "added 2 packages in 4s" };
  };
  const dl = join(home, "dl");
  const install = (version: string, from: InstallFrom, extra: Record<string, unknown> = {}) => installCodex(version, from, { ...base, npm: "C:\\nodejs\\npm.cmd", downloadsDir: dl, run, retryDelaysMs: [10, 10], ...extra });
  return { f, home, env, base, runs, install, dl };
};

describe("Codex 安装 (codex-install.ts)", () => {
  it("gives both places: the server's newest ready version and npm's latest", async () => {
    const { f, base } = await setup();
    f.latest = "0.167.0";
    expect(await codexSources(base)).toEqual({ platform: "win32-x64", server: { version: "0.166.0", size: 200_000 }, official: { version: "0.167.0" }, preparing: null });
    expect((await codexSources({ ...base, account: null })).server).toBeNull();
    f.npmDown = true;
    expect((await codexSources(base)).official).toBeNull();
  });

  it("downloads the .tgz from the server, checks npm's sha512, puts it in npm's cache and runs npm install -g; nothing left", async () => {
    const { f, runs, install, dl } = await setup();
    f.cutNext = 50_000;
    const phases: string[] = [];
    const done = await install("0.166.0", "server", { onProgress: (p: { phase: string }) => phases.at(-1) !== p.phase && phases.push(p.phase) });
    expect(done).toMatchObject({ version: "0.166.0", from: "server" });
    expect(phases).toEqual(["manifest", "downloading", "verifying", "installing"]);
    const tgz = join(dl, "codex-0.166.0-win32-x64.tgz");
    expect(runs.map((r) => ({ exe: r.exe, args: r.args }))).toEqual([
      { exe: "C:\\nodejs\\npm.cmd", args: ["cache", "add", tgz] },
      { exe: "C:\\nodejs\\npm.cmd", args: ["install", "-g", "@openai/codex@0.166.0", "--no-fund", "--no-audit"] },
    ]);
    expect(runs[0]!.cached!.equals(f.tgz.get("0.166.0")!)).toBe(true);
    // npm's sha512 asked, the file from the server (going on after the cut); nothing left behind.
    const files = f.seen.filter((s) => s.path.endsWith(".tgz"));
    expect(files.map((s) => s.path)).toEqual(["/platform/mirror/codex/0.166.0/win32-x64/codex-0.166.0-win32-x64.tgz", "/platform/mirror/codex/0.166.0/win32-x64/codex-0.166.0-win32-x64.tgz"]);
    expect(files[1]!.range).toMatch(/^bytes=[1-9]\d*-$/);
    expect(f.seen[0]!.path).toBe("/npm/@openai%2fcodex/0.166.0-win32-x64");
    expect(readdirSync(dl)).toEqual([]);
  });

  it("from npm itself; npm away: the server's sha512 for a server download, nothing for npm's", async () => {
    const a = await setup();
    a.f.latest = "0.167.0";
    await a.install("0.167.0", "official");
    expect(a.f.seen.map((s) => s.path)).toContain("/npm/@openai/codex/-/codex-0.167.0-win32-x64.tgz");

    const b = await setup();
    b.f.npmDown = true;
    await b.install("0.166.0", "server");
    expect(b.runs).toHaveLength(2);
    await expect(b.install("0.166.0", "official")).rejects.toThrow(/拿不到 @openai\/codex@0\.166\.0-win32-x64 的 sha512/);
  });

  it("installs nothing that does not match; keeps a checked .tgz when npm fails, for the next try", async () => {
    const a = await setup();
    a.f.wrongIntegrity = true;
    await expect(a.install("0.166.0", "server")).rejects.toThrow(/和 npm 的 sha512 对不上/);
    expect(a.runs).toEqual([]);
    expect(readdirSync(a.dl)).toEqual([]);

    const b = await setup();
    mkdirSync(b.dl, { recursive: true });
    writeFileSync(join(b.dl, "codex-0.150.0-win32-x64.tgz"), "old");
    const failing: InstallRunner = async (_exe, args) => (args[0] === "install" ? { ok: false, out: "npm error code EBUSY\nnpm error syscall rename", reason: "error" } : { ok: true, out: "" });
    await expect(b.install("0.166.0", "server", { run: failing })).rejects.toThrow(/npm install -g @openai\/codex@0\.166\.0 没成功（出错）：\nnpm error code EBUSY/);
    expect(readdirSync(b.dl)).toEqual(["codex-0.166.0-win32-x64.tgz"]);
    // The next try does not download again.
    b.f.seen.length = 0;
    await b.install("0.166.0", "server");
    expect(b.f.seen.filter((s) => s.path.endsWith(".tgz"))).toEqual([]);
    expect(existsSync(join(b.dl, "codex-0.166.0-win32-x64.tgz"))).toBe(false);
  });

  it("tells OpenAI's standalone install from npm's", () => {
    const env = { USERPROFILE: "C:\\Users\\a", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", APPDATA: "C:\\Users\\a\\AppData\\Roaming" };
    expect(isStandaloneCodex("C:\\Users\\a\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe", env)).toBe(true);
    expect(isStandaloneCodex("C:\\Users\\a\\.codex\\packages\\standalone\\current\\bin\\codex.exe", env)).toBe(true);
    expect(isStandaloneCodex("C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd", env)).toBe(false);
    expect(isStandaloneCodex(null, env)).toBe(false);
  });
});
