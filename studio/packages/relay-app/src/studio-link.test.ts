import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStudio, openInStudio, parseStudioMark, studioHas } from "./studio-link.js";

// 在 Studio 里打开 (2026-11-05, J1): the shell finds a Studio running on this computer and asks it to show a session.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const DEVICE = "d_0123456789abcdef01234567";

function machine(opts: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-link-"));
  dirs.push(root);
  const amo = join(root, "amo");
  const data = join(root, "studio-data");
  mkdirSync(amo, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(amo, "device.json"), JSON.stringify({ id: DEVICE, name: "策划的电脑" }));
  const url = `http://127.0.0.1:${opts.port ?? 47911}`;
  writeFileSync(join(data, "host.json"), JSON.stringify({ url, port: opts.port ?? 47911, pid: 1 }));
  writeFileSync(join(data, "host-token"), "tok-123\n");
  const calls: Array<{ url: string; auth?: string; body?: string }> = [];
  let up = true;
  let known = true;
  const f = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body as string | undefined });
    if (!up) throw new Error("refused");
    if (input === `${url}/api/health`) return new Response(JSON.stringify({ ok: true, dataDir: data }));
    if (input === `${url}/api/ui/open`) return known ? new Response(JSON.stringify({ taskId: "t1", sessionId: "s-1" })) : new Response(JSON.stringify({ error: { code: "not_found", message: "没有会话 s-1（可能已经删掉了）" } }), { status: 404 });
    throw new Error("refused");
  }) as typeof fetch;
  return { amo, data, url, calls, f, down: () => (up = false), forget: () => (known = false) };
}

describe("studio-link", () => {
  it("reads Studio's marks only", () => {
    expect(parseStudioMark(`studio:${DEVICE}:s-1`)).toEqual({ device: DEVICE, sessionId: "s-1" });
    expect(parseStudioMark("bag-limit")).toBeNull();
  });

  it("finds Studio through its data dir, asks it to show the session with the Host's token, and says why not when it cannot", async () => {
    const m = machine();
    const env = { AMO_HOME: m.amo, AMO_STUDIO_DATA_DIR: m.data };
    expect(await findStudio(env, m.f)).toEqual({ url: m.url, token: "tok-123" });
    expect(await studioHas(`studio:${DEVICE}:s-1`, env, m.f)).toBe(true);
    // Another computer's session, or not Studio's: no button.
    expect(await studioHas("studio:d_ffffffffffffffffffffffff:s-1", env, m.f)).toBe(false);
    expect(await studioHas("bag-limit", env, m.f)).toBe(false);

    expect(await openInStudio(`studio:${DEVICE}:s-1`, env, m.f)).toBeNull();
    const open = m.calls.find((c) => c.url.endsWith("/api/ui/open"))!;
    expect(open).toMatchObject({ auth: "Bearer tok-123", body: JSON.stringify({ sessionId: "s-1" }) });
    m.forget();
    expect(await openInStudio(`studio:${DEVICE}:s-1`, env, m.f)).toContain("没有这个会话");
    m.down();
    expect(await studioHas(`studio:${DEVICE}:s-1`, env, m.f)).toBe(false);
    expect(await openInStudio(`studio:${DEVICE}:s-1`, env, m.f)).toBe("Studio 没开着");
  });

  it("finds a Studio from the sources by its Host on the usual port, which says where its data dir is", async () => {
    const m = machine({ port: 47900 });
    expect(await findStudio({ AMO_HOME: m.amo }, m.f)).toEqual({ url: m.url, token: "tok-123" });
    writeFileSync(join(m.amo, "platform.json"), JSON.stringify({ studioDataDir: m.data }));
    expect(await findStudio({ AMO_HOME: m.amo }, m.f)).toEqual({ url: m.url, token: "tok-123" });
  });
});
