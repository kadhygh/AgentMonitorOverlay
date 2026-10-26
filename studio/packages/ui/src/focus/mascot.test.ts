import { describe, expect, it } from "vitest";
import { exampleSessions, type Session } from "@amo-studio/protocol";
import { mascotFace } from "./mascot.js";

const at = (id: string, status: Session["status"], extra: Partial<Session> = {}): Session => ({ ...exampleSessions[0]!, id, status, updatedAt: "2026-10-26T10:00:00.000Z", archivedAt: null, kind: "main", ...extra });
const seen = { since: "2026-10-26T09:00:00.000Z", seen: {} };
const looked = (...ids: string[]) => ({ since: seen.since, seen: Object.fromEntries(ids.map((id) => [id, "2026-10-26T11:00:00.000Z"])) });
const limit = { limit: { resetsAt: null, message: "You've hit your session limit", autoContinue: false } };

describe("「AMO 娘」's face for the icons (2026-10-26, the person's table)", () => {
  it("待命 for an error not looked at or a session waiting for approval or an answer", () => {
    expect(mascotFace([at("a", "running"), at("b", "error")], seen)).toBe("idle");
    expect(mascotFace([at("a", "running"), at("b", "awaiting-approval")], seen)).toBe("idle");
    expect(mascotFace([at("b", "awaiting-answer"), at("c", "idle", { wake: limit })], seen)).toBe("idle");
    // An error looked at already is no longer news.
    expect(mascotFace([at("b", "error")], looked("b"))).toBeNull();
  });

  it("睿智 when a session stopped at its usage limit, before 认真 for running ones", () => {
    expect(mascotFace([at("a", "running"), at("c", "idle", { wake: limit })], looked("c"))).toBe("goofy");
  });

  it("认真 while one runs, 开心 when only finished work waits for review, nothing otherwise", () => {
    expect(mascotFace([at("a", "running"), at("b", "awaiting-review")], seen)).toBe("focused");
    expect(mascotFace([at("b", "awaiting-review")], looked("b"))).toBe("happy");
    expect(mascotFace([at("d", "completed")], seen)).toBe("happy");
    expect(mascotFace([at("d", "completed")], looked("d"))).toBeNull();
    expect(mascotFace([at("e", "running", { archivedAt: "2026-10-26T10:30:00.000Z" })], seen)).toBeNull();
    expect(mascotFace([], seen)).toBeNull();
  });
});
