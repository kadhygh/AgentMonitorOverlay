import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayClient, RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import { todoDeviceList, TODO_SHARED_LIST, type TodoView } from "@amo-studio/protocol";
import { TodoSync, type TodoAccount } from "./todo.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "amo-notes-todo-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function relay(store = new RelayStore(":memory:"), port = 0): Promise<{ server: RelayServer; store: RelayStore }> {
  const server = await startRelayServer({ store, host: "127.0.0.1", port, name: "测试组" });
  return { server, store };
}

/** A 便签 program's sync, as one device. */
function device(id: string, name: string, account: () => TodoAccount | null, settings = { useTodo: true, keepDays: 30 }, now?: () => number) {
  const views: TodoView[] = [];
  const home = tempDir();
  const sync = new TodoSync(home, { accountInfo: () => account(), account: async () => account(), device: () => ({ id, name }), settings: () => settings, changed: (v) => views.push(v), ...(now ? { now } : {}) });
  cleanup.push(() => sync.stop());
  return { sync, views, home, settings };
}

describe("待办's copy and sync (2026-11-01)", () => {
  it("two devices of an account: each one's list and the shared one, changes both ways", async () => {
    const { server, store } = await relay();
    cleanup.push(() => store.close(), () => server.close());
    const key = (await new RelayClient(server.url).register("老戴", "pw-dai")).key;
    const account = () => ({ server: server.url, name: "老戴", key });
    const desk = device("d_desk000000000000000000", "台式机", account);
    const phone = device("d_phone00000000000000000", "手机", account);

    await desk.sync.sync();
    expect(desk.sync.view()).toMatchObject({ status: "synced", loaded: true, items: [], account: { name: "老戴" } });

    desk.sync.change([
      { op: "put", id: "t_a00000000000001", list: todoDeviceList("d_desk000000000000000000"), text: "发测试包", order: 0 },
      { op: "put", id: "t_a00000000000002", list: TODO_SHARED_LIST, text: "交周报", order: 0 },
    ]);
    // Shown at once, before it is sent.
    expect(desk.sync.view()).toMatchObject({ pending: 2, items: [{ text: "发测试包", byName: "台式机" }, { text: "交周报" }] });
    await desk.sync.sync();
    expect(desk.sync.view().pending).toBe(0);

    await phone.sync.sync();
    const onPhone = phone.sync.view();
    expect(onPhone.items.map((i) => i.text).sort()).toEqual(["交周报", "发测试包"]);
    expect(onPhone.devices.map((d) => d.name).sort()).toEqual(["台式机", "手机"]);

    phone.sync.change([{ op: "put", id: "t_a00000000000001", done: true }]);
    await phone.sync.sync();
    await desk.sync.sync();
    expect(desk.sync.view().items.find((i) => i.id === "t_a00000000000001")).toMatchObject({ done: true });

    // Deleted on the phone: gone from the desk's copy after its next sync.
    phone.sync.change([{ op: "delete", id: "t_a00000000000002" }]);
    await phone.sync.sync();
    await desk.sync.sync();
    expect(desk.sync.view().items.map((i) => i.id)).toEqual(["t_a00000000000001"]);
    // The copy is in the program's home, per account.
    expect(Object.keys(JSON.parse(readFileSync(join(desk.home, "todo-cache.json"), "utf8")).accounts)).toEqual([`${server.url}\n老戴`]);
  });

  it("the server away: changes wait in the queue (also across a restart) and go when it is back", async () => {
    const dir = tempDir();
    const store = new RelayStore(join(dir, "relay.db"));
    cleanup.push(() => store.close());
    let { server } = await relay(store);
    const port = Number(new URL(server.url).port);
    const key = (await new RelayClient(server.url).register("老戴", "pw-dai")).key;
    const account = () => ({ server: `http://127.0.0.1:${port}`, name: "老戴", key });
    const desk = device("d_desk000000000000000000", "台式机", account);
    await desk.sync.sync();
    await server.close();

    desk.sync.change([{ op: "put", id: "t_b00000000000001", list: TODO_SHARED_LIST, text: "离线时记的", order: 0 }]);
    await desk.sync.sync();
    expect(desk.sync.view()).toMatchObject({ status: "offline", message: "连不上服务器", pending: 1, items: [{ text: "离线时记的" }] });

    // The program restarts while away: the queue is still there.
    desk.sync.stop();
    const again = new TodoSync(desk.home, { accountInfo: () => account(), account: async () => account(), device: () => ({ id: "d_desk000000000000000000", name: "台式机" }), settings: () => desk.settings, changed: () => undefined });
    cleanup.push(() => again.stop());
    expect(again.view()).toMatchObject({ pending: 1, items: [{ text: "离线时记的" }] });

    ({ server } = await relay(store, port));
    cleanup.push(() => server.close());
    await again.sync();
    expect(again.view()).toMatchObject({ status: "synced", message: null, pending: 0, items: [{ text: "离线时记的", rev: 1 }] });
  });

  it("signed out, a key that ran out, 使用待办 off, a change the server will not take", async () => {
    const { server, store } = await relay();
    cleanup.push(() => store.close(), () => server.close());
    const key = (await new RelayClient(server.url).register("老戴", "pw-dai")).key;
    let who: TodoAccount | null = null;
    const desk = device("d_desk000000000000000000", "台式机", () => who);
    await desk.sync.sync();
    expect(desk.sync.view()).toMatchObject({ status: "signed-out", account: null, items: [] });
    expect(() => desk.sync.change([{ op: "delete", id: "t_x00000000000001" }])).toThrow("没有登录");

    who = { server: server.url, name: "老戴", key: "not-a-key" };
    await desk.sync.sync();
    expect(desk.sync.view()).toMatchObject({ status: "signed-out", message: "登录已失效，请在 AMO 平台里重新登录" });

    who = { server: server.url, name: "老戴", key };
    desk.sync.change([{ op: "put", id: "t_c00000000000001", list: "nowhere", text: "表不对", order: 0 }]);
    await desk.sync.sync();
    expect(desk.sync.view()).toMatchObject({ status: "synced", pending: 0, items: [] });
    expect(desk.sync.view().message).toContain("有 1 条改动服务器没收");

    desk.settings.useTodo = false;
    await desk.sync.sync();
    expect(desk.sync.view()).toMatchObject({ status: "off", message: null });
  });

  it("已完成保留: items done longer ago than that are deleted; 一直留着 keeps them", async () => {
    const { server, store } = await relay();
    cleanup.push(() => store.close(), () => server.close());
    const key = (await new RelayClient(server.url).register("老戴", "pw-dai")).key;
    let now = Date.now();
    const desk = device("d_desk000000000000000000", "台式机", () => ({ server: server.url, name: "老戴", key }), { useTodo: true, keepDays: 7 }, () => now);
    desk.sync.change([
      { op: "put", id: "t_d00000000000001", list: TODO_SHARED_LIST, text: "早就做完了", order: 0, done: true },
      { op: "put", id: "t_d00000000000002", list: TODO_SHARED_LIST, text: "还没做", order: 1 },
    ]);
    await desk.sync.sync();
    expect(desk.sync.view().items).toHaveLength(2);
    // The server stamps doneAt with its own clock: a week and a bit later here.
    now += 8 * 24 * 60 * 60_000;
    desk.settings.keepDays = 0;
    await desk.sync.sync();
    expect(desk.sync.view().items).toHaveLength(2);
    desk.settings.keepDays = 7;
    await desk.sync.sync();
    expect(desk.sync.view().items.map((i) => i.text)).toEqual(["还没做"]);
  });
});
