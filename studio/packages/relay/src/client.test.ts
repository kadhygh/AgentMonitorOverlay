import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAccount, saveAccount, type Protector } from "@amo-studio/account";
import { loadSettings, platformSettings, readSettings, settingsPath, writeSettings } from "./client.js";

// settings.json pointing at AMO 平台's account instead of holding its key (2026-11-04, the 11-03 audit).

// A reversible stand-in for DPAPI, so the test does not start PowerShell.
const protector: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => {
    const t = Buffer.from(d, "base64").toString();
    if (!t.startsWith("enc:")) throw new Error("not mine");
    return t.slice(4);
  },
};

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "amo-relay-settings-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("relay settings", () => {
  it("a login of its own keeps its key in the file", async () => {
    const home = fresh();
    writeSettings({ server: "http://a:47120", name: "小王", key: "k-own" }, home);
    expect(readSettings(home)).toEqual({ server: "http://a:47120", name: "小王", key: "k-own" });
    expect(platformSettings(home)).toBeNull();
    expect(await loadSettings(home, { env: { AMO_HOME: fresh() }, protector })).toEqual({ server: "http://a:47120", name: "小王", key: "k-own" });
  });

  it("the platform's account is a pointer: no key in the file, the key comes from account.json", async () => {
    const home = fresh();
    const env = { AMO_HOME: fresh() };
    await saveAccount({ server: "http://a:47120", name: "小王", key: "k-platform" }, { env, protector });
    writeSettings({ server: "http://a:47120", name: "小王", account: "platform" }, home);
    expect(readFileSync(settingsPath(home), "utf8")).not.toContain("k-platform");
    expect(readSettings(home)).toBeNull();
    expect(platformSettings(home)).toEqual({ server: "http://a:47120", name: "小王" });
    expect(await loadSettings(home, { env, protector })).toEqual({ server: "http://a:47120", name: "小王", key: "k-platform" });
  });

  it("logged out in the platform: not joined here either", async () => {
    const home = fresh();
    const env = { AMO_HOME: fresh() };
    await saveAccount({ server: "http://a:47120", name: "小王", key: "k-platform" }, { env, protector });
    writeSettings({ server: "http://a:47120", name: "小王", account: "platform" }, home);
    expect(await loadSettings(home, { env, protector })).not.toBeNull();
    clearAccount({ env });
    expect(await loadSettings(home, { env, protector })).toBeNull();
  });
});
