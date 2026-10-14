import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { agentsMdInstructions } from "./project-instructions.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amo-studio-test-agents-md-"));
});
afterEach(() => removeTempDir(dir));

describe("agentsMdInstructions", () => {
  it("brings AGENTS.md when the project has no CLAUDE.md", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Run npm test before you finish.\n");
    const text = agentsMdInstructions(dir)!;
    expect(text).toContain(`Contents of ${join(dir, "AGENTS.md")} (project instructions, checked into the codebase):`);
    expect(text).toContain("Run npm test before you finish.");
  });

  it("finds the files whatever their case", () => {
    writeFileSync(join(dir, "agents.md"), "lower case");
    expect(agentsMdInstructions(dir)).toContain("lower case");
  });

  it.each([["CLAUDE.md"], ["claude.md"], ["CLAUDE.local.md"], [join(".claude", "CLAUDE.md")]])("leaves it to Claude Code when there is %s", (claudeMd) => {
    writeFileSync(join(dir, "AGENTS.md"), "agents");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, claudeMd), "claude");
    expect(agentsMdInstructions(dir)).toBeNull();
  });

  it("adds nothing without an AGENTS.md, for an empty one or a missing dir", () => {
    expect(agentsMdInstructions(dir)).toBeNull();
    writeFileSync(join(dir, "AGENTS.md"), "  \n");
    expect(agentsMdInstructions(dir)).toBeNull();
    expect(agentsMdInstructions(join(dir, "missing"))).toBeNull();
  });

  it("leaves out the rest of a very long one", () => {
    writeFileSync(join(dir, "AGENTS.md"), "x".repeat(150_000));
    const text = agentsMdInstructions(dir)!;
    expect(text.length).toBeLessThan(101_000);
    expect(text).toContain("the rest is left out");
  });
});
