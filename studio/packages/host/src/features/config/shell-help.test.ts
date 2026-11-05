import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { shellHelpEnv } from "../../runtime/agent-env.js";
import { AMO_MCP_INSTRUCTIONS, amoInstructions, SHELL_HELP_INSTRUCTIONS } from "../../mcp/tools.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 设置 → 功能 → 命令行适配 (2026-11-06): Python's UTF-8 variables under every agent and the Windows command lines in the
// instructions, on by default, one switch for both.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-shellhelp-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("命令行适配", () => {
  it("is on by default: the variables go under the agents and the instructions carry the Windows lines", () => {
    expect(service.config.settings().shellHelp).toBe(true);
    expect(shellHelpEnv(store)).toEqual({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    expect(amoInstructions(service)).toBe(`${AMO_MCP_INSTRUCTIONS}\n\n${SHELL_HELP_INSTRUCTIONS}`);
    // The text shows the doubled backslash an agent may lose, not an escaped one.
    expect(SHELL_HELP_INSTRUCTIONS).toContain("`\\\\` in a path");
  });

  it("turned off, neither: no variables and the shared instructions only; on again brings both back", () => {
    service.config.updateSettings({ shellHelp: false });
    expect(service.config.settings().shellHelp).toBe(false);
    expect(shellHelpEnv(store)).toEqual({});
    expect(amoInstructions(service)).toBe(AMO_MCP_INSTRUCTIONS);
    service.config.updateSettings({ shellHelp: true });
    expect(shellHelpEnv(store)).toEqual({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("refuses anything but true or false", () => {
    expect(() => service.config.updateSettings({ shellHelp: "no" as never })).toThrow(/shellHelp/);
  });
});
