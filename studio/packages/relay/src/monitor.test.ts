import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerMonitor, topProcesses } from "./monitor.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";

const dirs: string[] = [];
const monitors: ServerMonitor[] = [];
let server: RelayServer | null = null;
let store: RelayStore | null = null;
afterEach(async () => {
  for (const m of monitors.splice(0)) m.close();
  await server?.close();
  store?.close();
  server = null;
  store = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "relay-monitor-"));
  dirs.push(d);
  return d;
};

describe("服务器状态 (monitor.ts)", () => {
  it("keeps its points in the file across a restart, only the last 24 hours", async () => {
    const dir = tmp();
    const file = join(dir, "monitor.json");
    const old = { t: Date.now() - 25 * 3600_000, cpu: 1, relayCpu: 0, load: 0, memUsed: 1, memTotal: 2, rss: 1, people: 0, devices: 0 };
    const recent = { ...old, t: Date.now() - 3600_000, cpu: 7 };
    writeFileSync(file, JSON.stringify({ points: [old, recent] }));
    const m = new ServerMonitor({ file, counts: () => ({ people: 2, devices: 1 }), everyMs: 3600_000 });
    monitors.push(m);
    expect(m.history()).toEqual([recent]);
    const p = await m.sample();
    expect(p).toMatchObject({ people: 2, devices: 1 });
    expect(p.memUsed).toBeGreaterThan(0);
    expect(p.memUsed).toBeLessThanOrEqual(p.memTotal);
    expect(p.cpu).toBeGreaterThanOrEqual(0);
    expect(p.cpu).toBeLessThanOrEqual(100);
    expect((JSON.parse(readFileSync(file, "utf8")) as { points: unknown[] }).points).toHaveLength(2);
    // A broken file only loses the curve.
    writeFileSync(file, "{nope");
    const again = new ServerMonitor({ file, counts: () => ({ people: 0, devices: 0 }) });
    monitors.push(again);
    expect(again.history()).toEqual([]);
  });

  it("groups ps lines by app and names Jenkins and the relay", () => {
    const ps = [
      "28346 1394528   0.0 /opt/homebrew/opt/openjdk@21/bin/java -jar /opt/homebrew/opt/jenkins-lts/libexec/jenkins.war",
      " 4618 311952   1.5 /Applications/ChatGPT.app/Contents/Frameworks/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)",
      " 4579 292848   0.1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      "54135  89392   0.0 /opt/homebrew/bin/node /Users/td/Services/amo-relay/app/amo-relay.mjs serve --port 47120",
      "  519   3104   0.1 /usr/libexec/clocksyncd",
    ].join("\n");
    expect(topProcesses(ps, 3)).toEqual([
      { name: "java（Jenkins）", count: 1, rss: 1394528 * 1024, cpu: 0 },
      { name: "ChatGPT", count: 2, rss: (311952 + 292848) * 1024, cpu: 1.6 },
      { name: "node（AMO 中转）", count: 1, rss: 89392 * 1024, cpu: 0 },
    ]);
  });

  it("the admin page's /api/admin/monitor: behind the admin password; now, the curve and the folders", async () => {
    store = new RelayStore(":memory:");
    store.setAdminPassword("admin-pw");
    const dataDir = tmp();
    writeFileSync(join(dataDir, "x.bin"), Buffer.alloc(3000));
    server = await startRelayServer({ store, dataDir, host: "127.0.0.1", port: 0, monitorEveryMs: 50 });
    const get = (pw: string) => fetch(`${server!.url}/api/admin/monitor`, { headers: { "x-amo-admin": pw } });
    expect((await get("wrong")).status).toBe(401);
    await new Promise((r) => setTimeout(r, 200));
    const body = (await (await get("admin-pw")).json()) as { everyMs: number; now: { point: { people: number }; dirs: Array<{ label: string; bytes: number }>; disk: unknown }; history: unknown[] };
    expect(body.everyMs).toBe(50);
    expect(body.history.length).toBeGreaterThan(0);
    expect(body.now.point.people).toBe(0);
    expect(body.now.dirs).toEqual([{ label: "数据", path: dataDir, bytes: expect.any(Number) }]);
    expect(body.now.dirs[0]!.bytes).toBeGreaterThanOrEqual(3000);
    expect(body.now.disk).toMatchObject({ free: expect.any(Number), total: expect.any(Number) });
    const page = await (await fetch(`${server.url}/admin`)).text();
    expect(page).toContain("服务器状态");
  });
});
