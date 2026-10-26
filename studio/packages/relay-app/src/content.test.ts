import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientManifest } from "@amo-studio/relay";
import { ContentStore } from "./content.js";

const BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let server: Server | null = null;
let home: string | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** A service with these client files; counts what is downloaded. */
async function serve(files: Record<string, string>) {
  const fetched: string[] = [];
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "").replace(/^\/client\//, ""));
    fetched.push(path);
    if (!(path in files)) return void res.writeHead(404).end();
    res.end(files[path]);
  });
  // fetch refuses a few ports (its "bad ports"); a random one can land on them.
  for (;;) {
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    if (!BAD_PORTS.has(port)) return { url: `http://127.0.0.1:${port}`, fetched };
    await new Promise<void>((r) => server!.close(() => r()));
  }
}

const manifest = (version: string, files: Record<string, string>): ClientManifest => ({
  version,
  builtAt: 1,
  minShell: 1,
  files: Object.entries(files).map(([path, body]) => ({ path, size: body.length, sha256: sha(body) })),
});

describe("ContentStore", () => {
  it("installs, reuses unchanged files on update, keeps the current and previous build", async () => {
    home = mkdtempSync(join(tmpdir(), "relay-content-"));
    const store = new ContentStore(home);
    expect(store.current()).toBeNull();
    const v1 = { "index.html": "<p>1</p>", "assets/a.js": "a1" };
    const s = await serve(v1);
    const progress: number[] = [];
    const one = await store.install(s.url, manifest("1", v1), (done) => progress.push(done));
    expect(store.current()).toEqual(one);
    expect(readFileSync(join(one.dir, "assets", "a.js"), "utf8")).toBe("a1");
    expect(progress.at(-1)).toBe(10);

    const v2 = { "index.html": "<p>2</p>", "assets/a.js": "a1" };
    const s2 = await (async () => (await new Promise<void>((r) => server!.close(() => r())), serve(v2)))();
    await store.install(s2.url, manifest("2", v2));
    expect(s2.fetched).toEqual(["index.html"]);
    expect(store.current()?.version).toBe("2");

    const v3 = { "index.html": "<p>3</p>" };
    const s3 = await (async () => (await new Promise<void>((r) => server!.close(() => r())), serve(v3)))();
    await store.install(s3.url, manifest("3", v3));
    expect(readdirSync(store.root).sort()).toEqual(["2", "3", "current.json"]);
  });

  it("refuses files whose hash does not match and keeps the current build", async () => {
    home = mkdtempSync(join(tmpdir(), "relay-content-"));
    const store = new ContentStore(home);
    const s = await serve({ "index.html": "changed meanwhile" });
    const bad = manifest("9", { "index.html": "what the manifest says" });
    await expect(store.install(s.url, bad)).rejects.toThrow(/校验不对/);
    expect(store.current()).toBeNull();
    expect(existsSync(join(store.root, "9"))).toBe(false);
    await expect(store.install(s.url, { ...bad, files: [{ path: "../evil.js", size: 1, sha256: "x" }] })).rejects.toThrow(/不安全/);
  });
});
