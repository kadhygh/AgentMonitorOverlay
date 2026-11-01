import { afterEach, describe, expect, it } from "vitest";
import { RelayClient } from "./client.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";
import { TODO_TOMBSTONE_DAYS, type TodoOpsResult, type TodoSnapshot } from "./todo-protocol.js";
import { TodoStore } from "./todo.js";

let server: RelayServer | null = null;
let store: RelayStore | null = null;
afterEach(async () => {
  await server?.close();
  store?.close();
  server = null;
  store = null;
});

const DESK = { device: "d_desk000000000000000000", name: "台式机" };
const PHONE = { device: "d_phone00000000000000000", name: "手机" };

async function service() {
  store = new RelayStore(":memory:");
  server = await startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组" });
  const anon = new RelayClient(server.url);
  const keys = { dai: (await anon.register("老戴", "pw-dai")).key, li: (await anon.register("老李", "pw-li")).key };
  const url = server.url;
  const call = async <T,>(key: string, method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json()) as T & { message?: string };
    if (!res.ok) throw new Error(json.message ?? String(res.status));
    return json;
  };
  const get = (key: string, d: typeof DESK, since = 0) => call<TodoSnapshot>(key, "GET", `/api/todo?device=${d.device}&deviceName=${encodeURIComponent(d.name)}&since=${since}`);
  const ops = (key: string, d: typeof DESK, list: unknown[]) => call<TodoOpsResult>(key, "POST", "/api/todo/ops", { device: d.device, deviceName: d.name, ops: list });
  return { keys, get, ops };
}

describe("待办 (2026-11-01)", () => {
  it("a device's list and the shared one, seen and changed from another device of the account, not from another account", async () => {
    const { keys, get, ops } = await service();
    const empty = await get(keys.dai, DESK);
    expect(empty).toMatchObject({ rev: 0, items: [], full: true, devices: [{ device: DESK.device, name: "台式机" }] });

    const r = await ops(keys.dai, DESK, [
      { op: "put", id: "t_a00001", list: `device:${DESK.device}`, text: "发测试包", order: 0 },
      { op: "put", id: "t_a00002", list: "shared", text: "交周报\n下午", order: 0 },
    ]);
    expect(r).toEqual({ rev: 2, rejected: [] });

    // The phone sees both lists and the desk among the devices; it ticks the desk's item and adds one to it.
    const onPhone = await get(keys.dai, PHONE);
    expect(onPhone.items.map((i) => [i.list, i.text, i.byName])).toEqual(
      expect.arrayContaining([
        [`device:${DESK.device}`, "发测试包", "台式机"],
        ["shared", "交周报 下午", "台式机"],
      ]),
    );
    expect(onPhone.devices.map((d) => d.name).sort()).toEqual(["台式机", "手机"]);
    await ops(keys.dai, PHONE, [
      { op: "put", id: "t_a00001", done: true },
      { op: "put", id: "t_b00001", list: `device:${DESK.device}`, text: "到公司跑 e2e", order: -1 },
    ]);

    // The desk asks for what changed since it last asked: only those two.
    const changes = await get(keys.dai, DESK, 2);
    expect(changes.full).toBe(false);
    expect(changes.rev).toBe(4);
    expect(changes.items.map((i) => [i.id, i.done, i.byName])).toEqual([
      ["t_a00001", true, "台式机"],
      ["t_b00001", false, "手机"],
    ]);
    expect(changes.items[0]!.doneAt).toBeGreaterThan(0);

    // Another account sees nothing of it.
    expect((await get(keys.li, DESK)).items).toEqual([]);
  });

  it("field by field, deleted stays deleted, bad changes are skipped and reported", async () => {
    const { keys, get, ops } = await service();
    await ops(keys.dai, DESK, [{ op: "put", id: "t_c00001", list: "shared", text: "原来的", order: 0 }]);
    // Two devices change different fields: both stay.
    await ops(keys.dai, PHONE, [{ op: "put", id: "t_c00001", done: true }]);
    await ops(keys.dai, DESK, [{ op: "put", id: "t_c00001", text: "改过的" }]);
    let item = (await get(keys.dai, DESK)).items[0]!;
    expect([item.text, item.done]).toEqual(["改过的", true]);

    // Unticked: doneAt goes; moved to the desk's list.
    await ops(keys.dai, DESK, [{ op: "put", id: "t_c00001", done: false, list: `device:${DESK.device}` }]);
    item = (await get(keys.dai, DESK)).items[0]!;
    expect([item.done, item.doneAt, item.list]).toEqual([false, null, `device:${DESK.device}`]);

    // Deleted on the desk; the phone, back from being away, still edits it: it stays deleted.
    const before = (await get(keys.dai, PHONE)).rev;
    await ops(keys.dai, DESK, [{ op: "delete", id: "t_c00001" }]);
    await ops(keys.dai, PHONE, [{ op: "put", id: "t_c00001", text: "离线时改的" }]);
    const after = await get(keys.dai, PHONE, before);
    expect(after.items.map((i) => [i.id, i.deleted])).toEqual([["t_c00001", true]]);
    expect((await get(keys.dai, PHONE)).items).toEqual([]);

    // A bad change is reported by its place; the good ones around it apply.
    const r = await ops(keys.dai, DESK, [
      { op: "put", id: "t_d00001", list: "shared", text: "好的", order: 0 },
      { op: "put", id: "t_d00002", list: "nowhere", text: "表不对" },
      { op: "put", id: "t_d00003", list: "shared", text: " " },
      { op: "put", id: "t_d00004", text: "新的但没有表" },
      { op: "put", id: "t_d00005", list: "shared", text: "也好", order: 1 },
    ]);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(r.rejected[0]!.message).toContain("没有这张表");
    expect((await get(keys.dai, DESK)).items.map((i) => i.text).sort()).toEqual(["也好", "好的"]);

    // Not a device: refused as a whole.
    await expect(get(keys.dai, { device: "?", name: "x" })).rejects.toThrow("设备编号不对");
  });

  it("deletion marks go after a while; a device last here before that gets everything again", async () => {
    store = new RelayStore(":memory:");
    let now = Date.UTC(2026, 10, 1);
    const todo = new TodoStore(store.db, () => now);
    todo.apply("老戴", DESK, [
      { op: "put", id: "t_e00001", list: "shared", text: "留着", order: 0 },
      { op: "put", id: "t_e00002", list: "shared", text: "删掉", order: 1 },
    ]);
    todo.apply("老戴", DESK, [{ op: "delete", id: "t_e00002" }]);
    expect(todo.snapshot("老戴", PHONE, 2)).toMatchObject({ full: false, items: [{ id: "t_e00002", deleted: true }] });

    now += (TODO_TOMBSTONE_DAYS + 1) * 24 * 60 * 60_000;
    todo.apply("老戴", DESK, [{ op: "put", id: "t_e00001", text: "还留着" }]);
    // The mark is gone, so asking from before it means everything there is now.
    const s = todo.snapshot("老戴", PHONE, 2);
    expect(s.full).toBe(true);
    expect(s.items.map((i) => i.text)).toEqual(["还留着"]);
    // Asking from after it: only the change.
    expect(todo.snapshot("老戴", PHONE, 3)).toMatchObject({ full: false, items: [{ id: "t_e00001" }] });
  });

  it("an account's todo follows a rename on the admin page", async () => {
    store = new RelayStore(":memory:");
    store.register("老戴", "pw-dai");
    const todo = new TodoStore(store.db);
    todo.apply("老戴", DESK, [{ op: "put", id: "t_f00001", list: "shared", text: "跟着走", order: 0 }]);
    store.renameMember("老戴", "戴老师");
    expect(todo.snapshot("戴老师", DESK, 0).items.map((i) => i.text)).toEqual(["跟着走"]);
    expect(todo.snapshot("戴老师", DESK, 0).rev).toBe(1);
  });
});
