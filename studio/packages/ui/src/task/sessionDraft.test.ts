import { afterEach, describe, expect, it } from "vitest";
import { readSessionDraft, writeSessionDraft } from "./sessionDraft.js";

const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

describe("session drafts", () => {
  afterEach(() => {
    store.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("keeps each session's draft apart, and forgets an emptied one", () => {
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    writeSessionDraft("s1", "写到一半");
    writeSessionDraft("s2", "另一个");
    expect(readSessionDraft("s1")).toBe("写到一半");
    expect(readSessionDraft("s2")).toBe("另一个");
    writeSessionDraft("s1", "  ");
    expect(readSessionDraft("s1")).toBe("");
    expect(Object.keys(JSON.parse(store.get("amo.sessionDrafts")!))).toEqual(["s2"]);
  });

  it("keeps only the most recent fifty", () => {
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    for (let i = 0; i < 55; i++) writeSessionDraft(`s${i}`, `d${i}`, i);
    expect(readSessionDraft("s0")).toBe("");
    expect(readSessionDraft("s54")).toBe("d54");
    expect(Object.keys(JSON.parse(store.get("amo.sessionDrafts")!))).toHaveLength(50);
  });

  it("works without storage", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    writeSessionDraft("s1", "x");
    expect(readSessionDraft("s1")).toBe("");
  });
});
