import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenInStudioRange } from "@amo-studio/testkit";
import { agyExe, agySources, installAgy } from "./agy-install.js";
import type { InstallFrom, InstallRunner } from "./tool-mirror.js";

// One fake server for both sides: Google's updater at /official/manifests/… (the newest only) and the exe it names, the
// team server's mirror at /api/platform/mirror/antigravity-cli and /platform/mirror/antigravity-cli/… (Bearer key "k").

interface Fake {
  url: string;
  latest: string;
  exe: Map<string, Buffer>;
  ready: Set<string>;
  officialDown: boolean;
  wrongChecksum: boolean;
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
  const d = mkdtempSync(join(tmpdir(), "platform-agy-"));
  dirs.push(d);
  return d;
};

const sha512 = (b: Buffer) => createHash("sha512").update(b).digest("hex");

async function fake(): Promise<Fake> {
  const f: Fake = { url: "", latest: "1.5.16", exe: new Map(), ready: new Set(["1.5.16"]), officialDown: false, wrongChecksum: false, seen: [], cutNext: null, server: null as unknown as Server };
  const exeOf = (v: string) => {
    if (!f.exe.has(v)) f.exe.set(v, Buffer.concat([randomBytes(100_000), Buffer.alloc(100_000, 5)]));
    return f.exe.get(v)!;
  };
  const sendExe = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, v: string) => {
    const exe = exeOf(v);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const body = exe.subarray(start);
    res.writeHead(m ? 206 : 200, { "content-length": String(body.length), ...(m ? { "content-range": `bytes ${start}-${exe.length - 1}/${exe.length}` } : {}) });
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
      if (path === "/official/manifests/windows_amd64.json") return void res.end(JSON.stringify({ version: f.latest, url: `${f.url}/official/bin/${f.latest}/cli_windows_x64.exe`, sha512: f.wrongChecksum ? "f".repeat(128) : sha512(exeOf(f.latest)) }));
      const b = /^\/official\/bin\/([^/]+)\/cli_windows_x64\.exe$/.exec(path);
      if (b) return sendExe(req, res, b[1]!);
      return no();
    }
    if (req.headers.authorization !== "Bearer k") return void (res.writeHead(401), res.end("{}"));
    if (path === "/api/platform/mirror/antigravity-cli") {
      const versions = [...f.ready].map((v) => ({ version: v, readyAt: "", platforms: { "win32-x64": { file: "agy.exe", size: exeOf(v).length, sha512: sha512(exeOf(v)) } } }));
      return void res.end(JSON.stringify({ official: f.latest, checkedAt: null, versions, preparing: null }));
    }
    const m = /^\/platform\/mirror\/antigravity-cli\/([^/]+)\/win32-x64\/agy\.exe$/.exec(path);
    if (m && f.ready.has(m[1]!)) return sendExe(req, res, m[1]!);
    return no();
  });
  await listenInStudioRange(f.server);
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  fakes.push(f);
  return f;
}

const runs: { exe: string; args: string[] }[] = [];
const run: InstallRunner = async (exe, args) => {
  runs.push({ exe, args });
  return { ok: true, out: "PATH configured" };
};

const setup = async () => {
  const f = await fake();
  const home = tmp();
  const env = { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), PROCESSOR_ARCHITECTURE: "AMD64" };
  const base = { env, account: { server: f.url, key: "k" }, base: `${f.url}/official` };
  const install = (version: string, from: InstallFrom, extra: Record<string, unknown> = {}) => installAgy(version, from, { ...base, downloadsDir: join(home, "dl"), run, retryDelaysMs: [10, 10], ...extra });
  return { f, home, env, base, install };
};

describe("Antigravity CLI 安装 (agy-install.ts, 2026-11-24)", () => {
  it("gives both places: the server's newest ready version and Google's latest", async () => {
    const { f, base } = await setup();
    f.latest = "1.5.17";
    expect(await agySources(base)).toMatchObject({ platform: "win32-x64", server: { version: "1.5.16" }, official: { version: "1.5.17" } });
    expect(await agySources({ ...base, account: null })).toMatchObject({ server: null, official: { version: "1.5.17" } });
    f.officialDown = true;
    expect(await agySources(base)).toMatchObject({ server: { version: "1.5.16" }, official: null });
  });

  it("downloads from Google, checks the sha512, puts it at %LOCALAPPDATA%\\agy\\bin and runs agy install", async () => {
    const { f, env, install } = await setup();
    runs.length = 0;
    f.cutNext = 50_000;
    const phases: string[] = [];
    const done = await install("1.5.16", "official", { onProgress: (p: { phase: string }) => phases.at(-1) !== p.phase && phases.push(p.phase) });
    expect(done).toEqual({ version: "1.5.16", from: "official", setup: null });
    expect(readFileSync(agyExe(env)).equals(f.exe.get("1.5.16")!)).toBe(true);
    expect(runs).toEqual([{ exe: agyExe(env), args: ["install"] }]);
    expect(phases).toEqual(["manifest", "downloading", "verifying", "installing"]);
    // It went on after the cut, and left no .part.
    expect(f.seen.filter((s) => s.path.endsWith(".exe")).map((s) => s.range)).toEqual([null, "bytes=50000-"]);
    expect(readdirSync(join(env.USERPROFILE, "dl"))).toEqual([]);
  });

  it("from the team server: an older version than Google's checked against the sha512 the server recorded", async () => {
    const { f, env, install } = await setup();
    f.latest = "1.5.17";
    await install("1.5.16", "server");
    expect(readFileSync(agyExe(env)).equals(f.exe.get("1.5.16")!)).toBe(true);
    expect(f.seen.some((s) => s.path === "/platform/mirror/antigravity-cli/1.5.16/win32-x64/agy.exe")).toBe(true);
    // From Google, only what its manifest names.
    await expect(install("1.5.16", "official")).rejects.toThrow(/现在是 1\.5\.17，不是 1\.5\.16/);
  });

  it("throws away a file whose sha512 is not Google's, and keeps the old agy", async () => {
    const { f, env, install } = await setup();
    mkdirSync(join(env.LOCALAPPDATA, "agy", "bin"), { recursive: true });
    writeFileSync(agyExe(env), "old");
    f.wrongChecksum = true;
    await expect(install("1.5.16", "official")).rejects.toThrow(/sha512 对不上/);
    expect(readFileSync(agyExe(env), "utf8")).toBe("old");
    expect(readdirSync(join(env.USERPROFILE, "dl"))).toEqual([]);
  });

  it("replaces an agy that is there (moved aside, removed when nothing runs from it); a failed agy install is said, not fatal", async () => {
    const { f, env, install } = await setup();
    const exe = agyExe(env);
    mkdirSync(join(env.LOCALAPPDATA, "agy", "bin"), { recursive: true });
    writeFileSync(exe, "old");
    // A Studio Gemini session runs it: the old one stays aside.
    await install("1.5.16", "official", { runningPaths: async () => [exe] });
    expect(readFileSync(exe).equals(f.exe.get("1.5.16")!)).toBe(true);
    expect(readdirSync(join(env.LOCALAPPDATA, "agy", "bin")).filter((n) => n.includes(".amo-old-"))).toHaveLength(1);
    const failing: InstallRunner = async () => ({ ok: false, out: "cannot write profile", reason: "error" });
    const done = await install("1.5.16", "official", { run: failing, runningPaths: async () => [] });
    expect(done.setup).toMatch(/agy install 没做完.*cannot write profile/s);
    expect(readdirSync(join(env.LOCALAPPDATA, "agy", "bin"))).toEqual(["agy.exe"]);
    expect(existsSync(exe)).toBe(true);
  });

  it("needs a sign-in for the server", async () => {
    const { base, home } = await setup();
    await expect(installAgy("1.5.16", "server", { ...base, account: null, downloadsDir: join(home, "dl"), run })).rejects.toThrow(/没登录团队服务器/);
  });
});
