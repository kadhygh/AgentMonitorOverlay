import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { findRelayClient, relayClientEnv, relayClientLaunch, relayTarget } from "./relay-client.js";

// 从 Studio 打开中转客户端 (2026-11-23): which exe Studio starts — the open client's (running.json) before AMO 平台's
// (programs.json) — with what, and an environment without the Host's own and the agents' variables.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDir(d);
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "amo-relay-client-"));
  dirs.push(root);
  const env = { AMO_HOME: join(root, "amo"), AMO_RELAY_HOME: join(root, "relay-home"), APPDATA: join(root, "appdata") };
  mkdirSync(env.AMO_HOME, { recursive: true });
  mkdirSync(env.AMO_RELAY_HOME, { recursive: true });
  const exe = (rel: string) => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
    return p;
  };
  const running = (value: unknown) => writeFileSync(join(env.AMO_RELAY_HOME, "running.json"), JSON.stringify(value));
  const programs = (value: unknown) => writeFileSync(join(env.AMO_HOME, "programs.json"), `\uFEFF${JSON.stringify(value)}`);
  return { root, env, exe, running, programs };
}

describe("找中转客户端", () => {
  it("the open client first, then AMO 平台's; neither: null", () => {
    const { env, exe, running, programs } = setup();
    expect(findRelayClient(env)).toBeNull();
    const installed = exe("apps/relay/0.9.11/AMO 中转.exe");
    programs({ tools: { studio: { version: "0.9.80", dir: "x", exe: "AMO Studio.exe" }, relay: { version: "0.9.11", dir: join(installed, ".."), exe: "AMO 中转.exe" } } });
    expect(findRelayClient(env)).toEqual({ exe: installed, from: "programs.json" });
    const open = exe("hand/AMO 中转.exe");
    running({ pid: 4242, exe: open, startedAt: "2026-11-23T10:00:00.000Z" });
    expect(findRelayClient(env)).toEqual({ exe: open, from: "running.json" });
  });

  it("passes over a running.json naming a client run from the sources (electron.exe) or one gone, and a programs.json entry whose exe is gone", () => {
    const { env, exe, running, programs } = setup();
    running({ pid: 1, exe: exe("node_modules/electron/dist/electron.exe") });
    expect(findRelayClient(env)).toBeNull();
    running({ pid: 1, exe: join(env.AMO_RELAY_HOME, "no-such.exe") });
    programs({ tools: { relay: { version: "0.9.10", dir: join(env.AMO_HOME, "gone"), exe: "AMO 中转.exe" } } });
    expect(findRelayClient(env)).toBeNull();
    running("not an object");
    expect(findRelayClient(env)).toBeNull();
  });

  it("without AMO_RELAY_HOME the home is %APPDATA%\\AMO Relay", () => {
    const { env, exe } = setup();
    const open = exe("hand/AMO 中转.exe");
    mkdirSync(join(env.APPDATA, "AMO Relay"), { recursive: true });
    writeFileSync(join(env.APPDATA, "AMO Relay", "running.json"), JSON.stringify({ pid: 1, exe: open }));
    expect(findRelayClient({ ...env, AMO_RELAY_HOME: undefined })).toEqual({ exe: open, from: "running.json" });
  });

  it("starts it with --open=<cowork:id | thread:id> only, and without the Host's and the agents' variables", () => {
    expect(relayTarget("cowork:t_977a117f")).toBe("cowork:t_977a117f");
    expect(relayTarget(" thread:t_1 ")).toBe("thread:t_1");
    for (const bad of ["t_1", "cowork:", "cowork:a b", "studio:d:s", "cowork:x --amo-quit", 42]) expect(relayTarget(bad)).toBeNull();
    const env = { PATH: "C:\\Windows", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\x\\AppData\\Roaming", AMO_HOME: "C:\\amo", ELECTRON_RUN_AS_NODE: "1", AMO_STUDIO_DATA_DIR: "D:\\studio", AMO_STUDIO_PORT: "47900", CLAUDECODE: "1", ANTHROPIC_API_KEY: "k", CODEX_HOME: "c", OPENAI_API_KEY: "k", DEEPSEEK_API_KEY: "k", DSH_HOME: "d", NODE_OPTIONS: "--x", NO_COLOR: "1" };
    const launch = relayClientLaunch({ exe: "C:\\apps\\AMO 中转.exe", from: "running.json" }, "cowork:t_1", env);
    expect(launch).toEqual({ exe: "C:\\apps\\AMO 中转.exe", args: ["--open=cowork:t_1"], env: { PATH: "C:\\Windows", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\x\\AppData\\Roaming", AMO_HOME: "C:\\amo" } });
    expect(relayClientEnv({ Path: "p", electron_run_as_node: "1" })).toEqual({ Path: "p" });
  });
});
