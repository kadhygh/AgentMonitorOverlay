import { describe, expect, it } from "vitest";
import { exampleItems, exampleSessions, type HostEvent, type SessionItem } from "@amo-studio/protocol";
import { applyItemEvent } from "../host/useSessionItems.js";
import { applyEvent } from "../host/useHostState.js";
import { relativeTime, taskStatus } from "./status.js";
import { mergeFirstLoad } from "../host/events.js";

describe("taskStatus", () => {
  it("picks the most urgent live session status", () => {
    expect(taskStatus(exampleSessions)).toBe("awaiting-approval");
    expect(taskStatus(exampleSessions.map((s) => ({ ...s, status: "idle" as const })))).toBe("idle");
    expect(taskStatus([{ ...exampleSessions[0]!, status: "error" }, { ...exampleSessions[1]!, status: "running" }])).toBe("error");
  });

  it("ignores archived sessions and returns null without any", () => {
    expect(taskStatus([{ ...exampleSessions[0]!, archivedAt: "2026-10-12T00:00:00Z" }])).toBeNull();
    expect(taskStatus([])).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  it("formats recent times in Chinese", () => {
    expect(relativeTime("2026-10-12T11:59:40Z", now)).toBe("刚刚");
    expect(relativeTime("2026-10-12T11:55:00Z", now)).toBe("5 分钟前");
    expect(relativeTime("2026-10-12T09:00:00Z", now)).toBe("3 小时前");
    expect(relativeTime("2026-10-10T12:00:00Z", now)).toBe("2 天前");
  });
});

describe("applyItemEvent", () => {
  const items = exampleItems.filter((i) => i.sessionId === "s-main");
  const streaming: SessionItem = { id: "i-new", sessionId: "s-main", seq: 5, createdAt: "", type: "agent", markdown: "", streaming: true };

  it("appends once, accumulates deltas, then takes the final text", () => {
    let cur = applyItemEvent(items, { seq: 1, type: "item.appended", item: streaming }, "s-main");
    cur = applyItemEvent(cur, { seq: 1, type: "item.appended", item: streaming }, "s-main");
    expect(cur.filter((i) => i.id === "i-new")).toHaveLength(1);
    cur = applyItemEvent(cur, { seq: 1, type: "item.delta", sessionId: "s-main", itemId: "i-new", append: "Hel" }, "s-main");
    cur = applyItemEvent(cur, { seq: 1, type: "item.delta", sessionId: "s-main", itemId: "i-new", append: "lo" }, "s-main");
    expect(cur.at(-1)).toMatchObject({ markdown: "Hello", streaming: true });
    cur = applyItemEvent(cur, { seq: 2, type: "item.updated", item: { ...streaming, markdown: "Hello!", streaming: false } as SessionItem }, "s-main");
    expect(cur.at(-1)).toMatchObject({ markdown: "Hello!", streaming: false });
  });

  it("ignores other sessions", () => {
    const other: HostEvent = { seq: 1, type: "item.appended", item: { ...streaming, sessionId: "s-fork" } };
    expect(applyItemEvent(items, other, "s-main")).toBe(items);
  });
});

describe("applyEvent", () => {
  it("upserts sessions and tracks the event sequence", () => {
    const state = { workspaces: [], topics: [], tasks: [], sessions: [exampleSessions[0]!], profiles: [], eventSeq: 3 };
    const next = applyEvent(state, { seq: 9, type: "session.upserted", session: { ...exampleSessions[0]!, status: "idle" } });
    expect(next.sessions[0]!.status).toBe("idle");
    expect(next.eventSeq).toBe(9);
  });
});

describe("mergeFirstLoad", () => {
  it("keeps items and changes that events delivered before the first snapshot arrived", () => {
    const loaded = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    const live = [{ id: "b", v: 2 }, { id: "c", v: 1 }];
    expect(mergeFirstLoad(loaded, live)).toEqual([{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 1 }]);
    expect(mergeFirstLoad(loaded, [])).toEqual(loaded);
  });
});
