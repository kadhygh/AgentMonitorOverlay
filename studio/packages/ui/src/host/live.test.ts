import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@amo-studio/protocol";
import { emitHostEvent, emitHostReconnect } from "./events.js";
import { keepWhere, removeById, upsertById, watchLive, type LiveOptions } from "./live.js";
import { sharedLive } from "./shared.js";

// The loop behind useLiveResource and the shared per-window values (2026-11-04, plans/done/cleanup-2026-11.md 第 7 步).

interface Item {
  id: string;
  v: number;
}
const upserted = (item: Item) => ({ type: "todo.upserted", todo: item }) as unknown as HostEvent;
const removed = (id: string) => ({ type: "todo.removed", todoId: id }) as unknown as HostEvent;
const onEvent = (cur: Item[], e: HostEvent): Item[] => {
  const ev = e as unknown as { type: string; todo?: Item; todoId?: string };
  if (ev.type === "todo.upserted" && ev.todo) return upsertById(cur, ev.todo);
  if (ev.type === "todo.removed" && ev.todoId) return removeById(cur, ev.todoId);
  return cur;
};

/** A fetch the test answers by hand, in any order. */
function answers<T>() {
  const pending: Array<{ resolve(v: T): void; reject(e: unknown): void }> = [];
  const load = () => new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  return { load, pending };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function watch(opts: Omit<LiveOptions<Item[]>, "initial">) {
  let value: Item[] = [];
  const w = watchLive<Item[]>(() => ({ initial: [], ...opts }), (next) => (value = next(value)));
  return { w, get: () => value };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  vi.useRealTimers();
});

describe("watchLive", () => {
  it("applies the events that came while the first load was out on top of its answer", async () => {
    const f = answers<Item[]>();
    const { w, get } = watch({ load: f.load, onEvent });
    stops.push(w.stop);
    emitHostEvent(upserted({ id: "new", v: 1 })); // added right away, before the snapshot answers
    emitHostEvent(removed("gone")); // removed after the snapshot was taken
    f.pending[0]!.resolve([{ id: "a", v: 1 }, { id: "gone", v: 1 }]);
    await tick();
    expect(get()).toEqual([{ id: "a", v: 1 }, { id: "new", v: 1 }]);
    emitHostEvent(upserted({ id: "a", v: 2 }));
    expect(get()).toEqual([{ id: "a", v: 2 }, { id: "new", v: 1 }]);
  });

  it("reads again on a reconnect and takes the answer as it is", async () => {
    const f = answers<Item[]>();
    const { w, get } = watch({ load: f.load, onEvent });
    stops.push(w.stop);
    f.pending[0]!.resolve([{ id: "a", v: 1 }, { id: "b", v: 1 }]);
    await tick();
    emitHostReconnect();
    expect(f.pending).toHaveLength(2);
    f.pending[1]!.resolve([{ id: "b", v: 2 }]); // "a" went while the socket was down
    await tick();
    expect(get()).toEqual([{ id: "b", v: 2 }]);
  });

  it("only the latest load's answer counts", async () => {
    const f = answers<Item[]>();
    const { w, get } = watch({ load: f.load, onEvent });
    stops.push(w.stop);
    w.reload();
    f.pending[1]!.resolve([{ id: "new", v: 1 }]);
    await tick();
    f.pending[0]!.resolve([{ id: "old", v: 1 }]);
    await tick();
    expect(get()).toEqual([{ id: "new", v: 1 }]);
  });

  it("reloadOn coalesces a burst of events into one read", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const { w } = watch({ load: async () => (reads++, []), reloadOn: (e) => e.type === "todo.upserted", reloadDelay: 150 });
    stops.push(w.stop);
    expect(reads).toBe(1);
    for (let i = 0; i < 5; i++) emitHostEvent(upserted({ id: String(i), v: 1 }));
    emitHostEvent(removed("x")); // not one of them
    expect(reads).toBe(1);
    vi.advanceTimersByTime(150);
    expect(reads).toBe(2);
  });

  it("a failed load goes to onError; nothing comes after stop", async () => {
    const f = answers<Item[]>();
    const onError = vi.fn();
    const { w, get } = watch({ load: f.load, onEvent, onError });
    f.pending[0]!.reject(new Error("断了"));
    await tick();
    expect(onError).toHaveBeenCalledOnce();
    w.stop();
    emitHostEvent(upserted({ id: "a", v: 1 }));
    emitHostReconnect();
    expect(get()).toEqual([]);
    expect(f.pending).toHaveLength(1);
  });
});

describe("list helpers", () => {
  it("upsert keeps the place, keepWhere moves to the end or out, remove leaves an untouched list as it is", () => {
    const list = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    expect(upsertById(list, { id: "a", v: 2 })).toEqual([{ id: "a", v: 2 }, { id: "b", v: 1 }]);
    expect(keepWhere(list, { id: "a", v: 2 }, true)).toEqual([{ id: "b", v: 1 }, { id: "a", v: 2 }]);
    expect(keepWhere(list, { id: "a", v: 2 }, false)).toEqual([{ id: "b", v: 1 }]);
    expect(removeById(list, "zz")).toBe(list);
  });
});

describe("sharedLive", () => {
  it("one read per Host for all its readers; again after a reconnect; the value stays when the last one goes", async () => {
    let reads = 0;
    const use = sharedLive<number>(() => ({ load: async () => ++reads, onEvent: (cur, e) => (e.type === "settings.updated" ? 100 : cur) }));
    const link = { url: "http://127.0.0.1:47999", token: "t" };
    const seen: string[] = [];
    const offA = use.subscribe(link, () => seen.push("a"));
    const offB = use.subscribe({ ...link }, () => seen.push("b")); // a reconnect hands a new object for the same Host
    await tick();
    expect(reads).toBe(1);
    expect(use.peek(link)).toBe(1);
    emitHostReconnect();
    await tick();
    expect(reads).toBe(2);
    emitHostEvent({ type: "settings.updated" } as unknown as HostEvent);
    expect(use.peek(link)).toBe(100);
    offA();
    offB();
    emitHostReconnect();
    await tick();
    expect(reads).toBe(2); // stopped
    expect(use.peek(link)).toBe(100);
    expect(seen.filter((s) => s === "a")).toHaveLength(seen.filter((s) => s === "b").length);
  });

  it("reads nothing for a link without an address", () => {
    let reads = 0;
    const use = sharedLive<number>(() => ({ load: async () => ++reads }));
    const off = use.subscribe({ url: "", token: "" }, () => undefined);
    expect(reads).toBe(0);
    expect(use.peek({ url: "", token: "" })).toBeNull();
    off();
  });
});
