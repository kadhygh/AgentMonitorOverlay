import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRelayExe } from "./relay-link.js";

// 在中转里打开 (2026-11-05): Studio finds the AMO 中转 client the way AMO 平台 knows it.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "amo-relay-link-"));
  dirs.push(d);
  return d;
}
const touch = (path: string) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, ""), path);

describe("findRelayExe", () => {
  it("takes the platform's install first, then the running client's own record, and never a bare electron.exe", () => {
    const root = temp();
    const env = { AMO_HOME: join(root, "amo"), AMO_RELAY_HOME: join(root, "relay-home") };
    expect(findRelayExe(env)).toBeNull();

    const running = touch(join(root, "unpacked", "AMO Relay.exe"));
    mkdirSync(env.AMO_RELAY_HOME, { recursive: true });
    writeFileSync(join(env.AMO_RELAY_HOME, "running.json"), JSON.stringify({ pid: 1, exe: running }));
    expect(findRelayExe(env)).toBe(running);

    const installed = touch(join(root, "apps", "relay", "0.9.9", "AMO Relay.exe"));
    mkdirSync(env.AMO_HOME, { recursive: true });
    writeFileSync(join(env.AMO_HOME, "programs.json"), JSON.stringify({ tools: { relay: { version: "0.9.9", dir: join(root, "apps", "relay", "0.9.9"), exe: "AMO Relay.exe" } } }));
    expect(findRelayExe(env)).toBe(installed);

    // From the sources the client is electron.exe with its app as an argument: not something to start bare.
    rmSync(join(env.AMO_HOME, "programs.json"));
    writeFileSync(join(env.AMO_RELAY_HOME, "running.json"), JSON.stringify({ pid: 1, exe: touch(join(root, "dev", "electron.exe")) }));
    expect(findRelayExe(env)).toBeNull();
  });
});
