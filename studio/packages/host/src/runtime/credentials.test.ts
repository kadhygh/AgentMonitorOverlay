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
});
