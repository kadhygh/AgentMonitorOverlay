import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRelayAttention, RelayAttentionReader, relayHomeDir, trayLook } from "./relay-attention.js";

describe("中转's count on the platform's tray (2026-10-29)", () => {
  it("finds 中转's folder as it does itself", () => {
    expect(relayHomeDir({ AMO_RELAY_HOME: "D:\\r", APPDATA: "C:\\A" })).toBe("D:\\r");
    expect(relayHomeDir({ APPDATA: "C:\\A" })).toBe(join("C:\\A", "AMO Relay"));
  });

  it("takes the file only while the 中转 that wrote it runs and something waits", () => {
    const yes = () => true;
    expect(parseRelayAttention(JSON.stringify({ count: 3, blink: true, pid: 1 }), yes)).toEqual({ count: 3, blink: true });
    expect(parseRelayAttention(JSON.stringify({ count: 3, blink: false, pid: 1 }), yes)).toEqual({ count: 3, blink: false });
    expect(parseRelayAttention(JSON.stringify({ count: 0, blink: false, pid: 1 }), yes)).toBeNull();
    expect(parseRelayAttention(JSON.stringify({ count: 3, blink: true, pid: 1 }), () => false)).toBeNull();
    expect(parseRelayAttention("{half", yes)).toBeNull();
    expect(parseRelayAttention(JSON.stringify({ count: "3", pid: 1 }), yes)).toBeNull();
  });

  it("the icon: the platform's own, or 中转's with the count (blinking as 中转 says)", () => {
    expect(trayLook(null)).toEqual({ icon: "platform", count: 0, blink: false, tooltip: "AMO 平台" });
    expect(trayLook({ count: 4, blink: true })).toEqual({ icon: "relay", count: 4, blink: true, tooltip: "AMO 平台 · 中转有 4 条待处理 / 未读" });
  });

  it("reads the file again when it changes, and notices 中转 gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "amo-platform-relay-"));
    const file = join(dir, "attention.json");
    let running = true;
    const reader = new RelayAttentionReader(file, () => running);
    try {
      expect(reader.read(0)).toBeNull();
      writeFileSync(file, JSON.stringify({ count: 2, blink: true, pid: 7 }));
      expect(reader.read(1000)).toEqual({ count: 2, blink: true });
      writeFileSync(file, JSON.stringify({ count: 12, blink: false, pid: 7 }));
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(reader.read(2000)).toEqual({ count: 12, blink: false });
      // Crashed without removing it: seen within a few seconds.
      running = false;
      expect(reader.read(3000)).toEqual({ count: 12, blink: false });
      expect(reader.read(8000)).toBeNull();
      rmSync(file);
      expect(reader.read(9000)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
