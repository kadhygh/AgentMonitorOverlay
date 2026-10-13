import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_SCRATCHPAD_SHORTCUT, normalizeShortcut, type Attachment, type HostEvent, type ModelProfile, type Scratchpad, type StateSnapshot, type StudioSettings } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { readScratchpad, visibleScratchpad, withPage, withPageCount } from "./doc.js";

describe("scratchpad document", () => {
  it("turns stage 2's single text into page 1 of three", () => {
    const doc = readScratchpad(undefined, "旧草稿");
    expect(doc).toEqual({ pages: [{ text: "旧草稿", attachments: [] }, { text: "", attachments: [] }, { text: "", attachments: [] }], pageCount: 3, activePage: 0 });
    expect(readScratchpad(undefined, undefined).pages[0]!.text).toBe("");
    // A damaged value falls back to the old text rather than losing it.
    expect(readScratchpad("{not json", "旧草稿").pages[0]!.text).toBe("旧草稿");
  });

  it("reads a stored document, clamping what is out of range", () => {
    const raw = JSON.stringify({ pages: [{ text: "a", attachments: ["att-1", 3] }, { text: 5 }], pageCount: 4, activePage: 7 });
    const doc = readScratchpad(raw, "ignored");
    expect(doc.pages).toHaveLength(4);
    expect(doc.pages[0]).toEqual({ text: "a", attachments: ["att-1"] });
    expect(doc.pages[1]).toEqual({ text: "", attachments: [] });
    expect(doc.activePage).toBe(3);
    expect(readScratchpad(JSON.stringify({ pages: [], pageCount: 99 }), undefined).pageCount).toBe(9);
  });

  it("hides pages past the count without deleting them", () => {
    let doc = readScratchpad(undefined, "one");
    doc = withPage(doc, 2, { text: "three" });
    doc = { ...doc, activePage: 2 };
    const fewer = withPageCount(doc, 1);
    const shown = visibleScratchpad(fewer, null);
    expect(shown.pages.map((p) => p.text)).toEqual(["one"]);
    expect(shown.activePage).toBe(0);
    expect(shown.keptPages).toEqual([3]);
    // Trailing empty pages are dropped; pages with something stay and come back.
    expect(fewer.pages).toHaveLength(3);
    expect(visibleScratchpad(withPageCount(fewer, 3), null).pages.map((p) => p.text)).toEqual(["one", "", "three"]);
    expect(withPageCount(readScratchpad(undefined, ""), 1).pages).toHaveLength(1);
  });
});

describe("scratchpad shortcut", () => {
  it("keeps keys Studio can register, in canonical form", () => {
    expect(normalizeShortcut(DEFAULT_SCRATCHPAD_SHORTCUT)).toBe("Ctrl+Alt+Space");
    expect(normalizeShortcut(" alt + control + z ")).toBe("Ctrl+Alt+Z");
    expect(normalizeShortcut("Shift+Super+1")).toBe("Shift+Super+1");
    expect(normalizeShortcut("F9")).toBe("F9");
    expect(normalizeShortcut("")).toBe("");
  });

  it("refuses keys that would swallow typing or that it cannot name", () => {
    for (const bad of ["Z", "Shift+Z", "Ctrl+Ctrl+Z", "Ctrl+", "Ctrl+Mouse4", "Hyper+Z", "Ctrl+Alt"]) expect(normalizeShortcut(bad)).toBeNull();
  });
});

// Through the HTTP API, like the UI uses it.
const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;
let service: HostService;

async function boot() {
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
}

async function shutdown() {
  await http.close();
  await servers.close();
  store.close();
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}
const ok = async <T>(method: string, path: string, body?: unknown) => {
  const r = await api<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

describe("scratchpad API", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-pad-"));
    await boot();
  });
  afterEach(async () => {
    await shutdown();
    removeTempDir(root);
  });

  it("starts empty, and keeps the text written before stage 11 as page 1", async () => {
    expect(await ok<Scratchpad>("GET", "/api/scratchpad")).toEqual({ pages: [1, 2, 3].map(() => ({ text: "", attachments: [] })), activePage: 0, keptPages: [], updatedAt: null });
    store.setKv("scratchpad", "明天：\n- 发版");
    const pad = await ok<Scratchpad>("GET", "/api/scratchpad");
    expect(pad.pages[0]!.text).toBe("明天：\n- 发版");
    expect(pad.updatedAt).toBeTruthy();
  });

  it("writes pages, switches and counts them, announcing every change, and survives a restart", async () => {
    const received: HostEvent[] = [];
    const ws = new WebSocket(`${http.url.replace("http", "ws")}/api/events?token=${TOKEN}&since=${(await ok<StateSnapshot>("GET", "/api/state")).eventSeq}`);
    ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as HostEvent));
    await new Promise<void>((r) => ws.once("open", () => r()));

    await ok("PUT", "/api/scratchpad/pages/2", { text: "第二页" });
    const switched = await ok<Scratchpad>("PATCH", "/api/scratchpad", { activePage: 1, pageCount: 5 });
    expect(switched.pages).toHaveLength(5);
    expect(switched.activePage).toBe(1);
    expect(switched.pages[1]!.text).toBe("第二页");
    const pads = () => received.flatMap((e) => (e.type === "scratchpad.updated" ? [e.scratchpad] : []));
    await expect.poll(() => pads().length).toBe(2);
    expect(pads()[1]!.activePage).toBe(1);
    ws.close();

    expect((await api("PUT", "/api/scratchpad/pages/1", { text: 42 })).status).toBe(400);
    expect((await api("PUT", "/api/scratchpad/pages/10", { text: "x" })).status).toBe(400);
    expect((await api("PUT", "/api/scratchpad/pages/0", { text: "x" })).status).toBe(400);
    expect((await api("PATCH", "/api/scratchpad", { pageCount: 0 })).status).toBe(400);
    expect((await api("PATCH", "/api/scratchpad", { activePage: 5 })).status).toBe(400);

    await shutdown();
    await boot();
    const after = await ok<Scratchpad>("GET", "/api/scratchpad");
    expect(after.pages).toHaveLength(5);
    expect(after.pages[1]!.text).toBe("第二页");
    expect(after.activePage).toBe(1);
  });

  it("attaches only images the Host keeps", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const res = await fetch(`${http.url}/api/attachments?type=image/png&name=shot.png`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" }, body: png });
    const att = (await res.json()) as Attachment;
    const pad = await ok<Scratchpad>("PUT", "/api/scratchpad/pages/1", { attachments: [att.id, att.id] });
    expect(pad.pages[0]!.attachments).toEqual([att.id]);
    // Text and images are saved separately: one does not wipe the other.
    expect((await ok<Scratchpad>("PUT", "/api/scratchpad/pages/1", { text: "看图" })).pages[0]).toEqual({ text: "看图", attachments: [att.id] });
    expect((await api("PUT", "/api/scratchpad/pages/1", { attachments: ["att-00000000-0000-0000-0000-000000000000"] })).status).toBe(400);
    expect((await api("PUT", "/api/scratchpad/pages/1", { attachments: "nope" })).status).toBe(400);
  });

  it("keeps the window's shortcut in the settings", async () => {
    expect((await ok<StudioSettings>("GET", "/api/settings")).scratchpadShortcut).toBe(DEFAULT_SCRATCHPAD_SHORTCUT);
    expect((await ok<StudioSettings>("PUT", "/api/settings", { scratchpadShortcut: "alt+ctrl+z" })).scratchpadShortcut).toBe("Ctrl+Alt+Z");
    expect((await api("PUT", "/api/settings", { scratchpadShortcut: "Z" })).status).toBe(400);
    expect((await ok<StudioSettings>("PUT", "/api/settings", { scratchpadShortcut: "" })).scratchpadShortcut).toBe("");
    expect((await ok<StudioSettings>("GET", "/api/settings")).scratchpadShortcut).toBe("");
  });
});
