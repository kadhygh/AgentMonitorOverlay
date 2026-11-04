import { afterEach, describe, expect, it, vi } from "vitest";
import { readStored, readStoredJson, writeStored, writeStoredJson } from "./stored.js";

afterEach(() => vi.unstubAllGlobals());

function fakeStorage(full = false) {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

describe("stored", () => {
  it("reads and writes text and JSON; null takes a key away", () => {
    const map = fakeStorage();
    writeStored("a", "1");
    expect(readStored("a")).toBe("1");
    writeStoredJson("b", { x: [1] });
    expect(readStoredJson("b")).toEqual({ x: [1] });
    writeStored("a", null);
    expect(map.has("a")).toBe(false);
    expect(readStored("a")).toBeNull();
    expect(readStoredJson("a")).toBeUndefined();
  });

  it("a value that does not parse reads as nothing", () => {
    fakeStorage().set("c", "{oops");
    expect(readStoredJson("c")).toBeUndefined();
  });

  it("no storage, or a full one, is not an error", () => {
    // vitest's node environment has no localStorage at all
    expect(readStored("a")).toBeNull();
    expect(() => writeStored("a", "1")).not.toThrow();
    fakeStorage(true);
    expect(() => writeStoredJson("a", [1])).not.toThrow();
  });
});
