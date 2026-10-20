import { describe, expect, it } from "vitest";
import { StaticCredentialReader, WindowsCredentialReader } from "./credentials.js";

describe("credentials", () => {
  it("keeps test secrets in memory", () => {
    const store = new StaticCredentialReader({});
    store.write("x", "  secret \n");
    expect(store.read("x")).toBe("secret");
    store.remove("x");
    expect(store.read("x")).toBeNull();
  });

  // Uses its own entry (AmoStudioTest/...), never AgentMonitorOverlay/model-provider/*.
  it.runIf(process.platform === "win32")("saves, reads back and removes an entry in the Credential Manager", () => {
    const id = `probe-${process.pid}`;
    const writer = new WindowsCredentialReader("AmoStudioTest/");
    try {
      writer.write(id, "sk-test 中文 \"quoted\" $(not-run)\n");
      // A fresh reader has no cache: this really reads the entry back.
      expect(new WindowsCredentialReader("AmoStudioTest/").read(id)).toBe('sk-test 中文 "quoted" $(not-run)');
    } finally {
      writer.remove(id);
    }
    expect(new WindowsCredentialReader("AmoStudioTest/").read(id)).toBeNull();
    // Removing what is not there is fine.
    writer.remove(id);
  }, 60_000);

  it.runIf(process.platform === "win32")("preloads every entry at once; afterwards a missing one is null without PowerShell", async () => {
    const id = `probe-pre-${process.pid}`;
    const writer = new WindowsCredentialReader("AmoStudioTest/");
    try {
      writer.write(id, "sk-pre 中文\n");
      const reader = new WindowsCredentialReader("AmoStudioTest/");
      await reader.preload();
      const started = Date.now();
      expect(reader.read(id)).toBe("sk-pre 中文");
      expect(reader.read(`missing-${process.pid}`)).toBeNull();
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      writer.remove(id);
    }
  }, 60_000);
});
