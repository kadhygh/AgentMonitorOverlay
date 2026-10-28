import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, startFakePlatformServer, type FakePlatformServer } from "@amo-studio/testkit";
import { amoHome, amoLocalHome, accountFile, AccountError, clearAccount, dpapi, login, logout, normalizeServer, platformFile, pushRecent, readAccount, readAccountInfo, recentServers, rememberServer, type Protector } from "./index.js";

// A reversible stand-in for DPAPI, so most tests do not start PowerShell.
const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => {
    const t = Buffer.from(d, "base64").toString();
    if (!t.startsWith("enc:")) throw new Error("not mine");
    return t.slice(4);
  },
};

let server: FakePlatformServer;
let dir = "";
const env = () => ({ AMO_HOME: dir });

beforeAll(async () => {
  server = await startFakePlatformServer({ users: { 小王: "secret" } });
});
afterAll(() => server.close());
afterEach(() => dir && removeTempDir(dir));
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "amo-account-")));

describe("paths", () => {
  it("follows AMO_HOME / AMO_LOCAL_HOME, else %APPDATA% / %LOCALAPPDATA%", () => {
    expect(amoHome({ AMO_HOME: "C:\\x\\amo" })).toBe("C:\\x\\amo");
    expect(amoHome({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe("C:\\Users\\a\\AppData\\Roaming\\AMO");
    expect(amoLocalHome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" })).toBe("C:\\Users\\a\\AppData\\Local\\AMO");
    expect(accountFile({ AMO_HOME: "C:\\x" })).toBe("C:\\x\\account.json");
    expect(platformFile({ AMO_HOME: "C:\\x" })).toBe("C:\\x\\platform.json");
  });
});

describe("login and the stored account", () => {
  it("logs in, keeps the key encrypted, reads it back, and remembers the server", async () => {
    fresh();
    const a = await login({ server: server.url.replace("http://", "") + "/", name: "小王", password: "secret" }, { env: env(), protector: fake });
    expect(a.server).toBe(server.url);
    expect(a.name).toBe("小王");
    expect(a.role).toBe("程序");
    const stored = JSON.parse(readFileSync(join(dir, "account.json"), "utf8")) as { server: string; name: string; key: string };
    expect(Object.keys(stored).sort()).toEqual(["key", "name", "server"]);
    expect(stored.key).not.toBe(a.key);
    expect(readAccountInfo({ env: env() })).toEqual({ server: server.url, name: "小王" });
    expect(await readAccount({ env: env(), protector: fake })).toEqual({ server: server.url, name: "小王", key: a.key });
    expect(recentServers({ env: env() })).toEqual([server.url]);
    // The key works on the server.
    const res = await fetch(`${server.url}/api/platform/channels`, { headers: { authorization: `Bearer ${a.key}` } });
    expect(res.status).toBe(200);
  });

  it("says why a login failed: wrong password, nothing there, empty fields", async () => {
    fresh();
    await expect(login({ server: server.url, name: "小王", password: "nope" }, { env: env(), protector: fake })).rejects.toMatchObject({ code: "unauthorized", message: "名字或密码不对" });
    await expect(login({ server: "127.0.0.1:1", name: "小王", password: "x" }, { env: env(), protector: fake })).rejects.toMatchObject({ code: "unreachable" });
    await expect(login({ server: " ", name: "小王", password: "x" }, { env: env(), protector: fake })).rejects.toBeInstanceOf(AccountError);
    expect(readAccountInfo({ env: env() })).toBeNull();
  });

  it("a key this user cannot decrypt reads as logged out", async () => {
    fresh();
    writeFileSync(join(dir, "account.json"), JSON.stringify({ server: server.url, name: "小王", key: Buffer.from("someone else").toString("base64") }));
    expect(readAccountInfo({ env: env() })).toEqual({ server: server.url, name: "小王" });
    expect(await readAccount({ env: env(), protector: fake })).toBeNull();
  });

  it("logout tells the server and forgets the account", async () => {
    fresh();
    const a = await login({ server: server.url, name: "小王", password: "secret" }, { env: env(), protector: fake });
    await logout({ env: env(), protector: fake });
    expect(readAccountInfo({ env: env() })).toBeNull();
    const res = await fetch(`${server.url}/api/platform/channels`, { headers: { authorization: `Bearer ${a.key}` } });
    expect(res.status).toBe(401);
    // Nothing stored: nothing to do.
    await logout({ env: env(), protector: fake });
    clearAccount({ env: env() });
  });
});

describe("recent servers", () => {
  it("newest first, no repeats, at most 3, other platform.json keys kept", () => {
    fresh();
    expect(pushRecent(["http://a:1", "http://b:1"], "b:1")).toEqual(["http://b:1", "http://a:1"]);
    writeFileSync(join(dir, "platform.json"), JSON.stringify({ channel: "test", studioDataDir: "D:\\data" }));
    for (const s of ["a:1", "b:1", "c:1", "d:1", "b:1"]) rememberServer(s, { env: env() });
    expect(recentServers({ env: env() })).toEqual(["http://b:1", "http://d:1", "http://c:1"]);
    const p = JSON.parse(readFileSync(join(dir, "platform.json"), "utf8")) as Record<string, unknown>;
    expect(p).toMatchObject({ channel: "test", studioDataDir: "D:\\data", server: "http://b:1" });
    expect(normalizeServer("https://x.example/")).toBe("https://x.example");
  });
});

// The real thing once: PowerShell + ProtectedData for this Windows user.
describe.runIf(process.platform === "win32")("DPAPI", () => {
  it("round-trips through ProtectedData, and the stored text is not the key", async () => {
    const key = "k3y-ä中文-" + Date.now();
    const enc = await dpapi.protect(key);
    expect(enc).not.toContain(key);
    expect(Buffer.from(enc, "base64").length).toBeGreaterThan(key.length);
    expect(await dpapi.unprotect(enc)).toBe(key);
    await expect(dpapi.unprotect(Buffer.from("garbage").toString("base64"))).rejects.toThrow();
  }, 30_000);
});
