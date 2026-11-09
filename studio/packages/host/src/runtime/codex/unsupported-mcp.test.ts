import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { StaticCredentialReader } from "../credentials.js";
import { CodexServerManager } from "./server-manager.js";

// MCP servers Codex is not given (2026-11-09): its config takes stdio and HTTP ones (profiles.ts), so an SSE one that is
// on is left out — and named, so the session can say so. No Codex is started here.

const root = mkdtempSync(join(tmpdir(), "amo-codex-unsupported-mcp-"));
afterAll(() => removeTempDir(root));

describe("CodexServerManager.unsupportedMcp", () => {
  it("names the servers that are on but Codex cannot take", () => {
    const m = new CodexServerManager({
      dataDir: join(root, "data"),
      profiles: [],
      credentials: new StaticCredentialReader({}),
      cwd: root,
      extraMcp: () => ({
        img: { type: "stdio", command: "npx" },
        figma: { type: "http", url: "https://mcp.figma.com/mcp" },
        "gorilla-canvas": { type: "sse", url: "https://canvas.example/api/mcp/sse" },
      }),
    });
    expect(m.unsupportedMcp()).toEqual([{ name: "gorilla-canvas", type: "sse" }]);
  });
});
