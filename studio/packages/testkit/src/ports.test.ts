import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { listenInStudioRange, noteHandedOut, portsInTurn, STUDIO_SPARE_PORTS, standInPort } from "./ports.js";

describe("standInPort", () => {
  it("is a port of the spare range that none of the servers the test talks to has, given as urls or numbers", () => {
    const [lo, hi] = STUDIO_SPARE_PORTS;
    expect(standInPort()).toBe(hi);
    expect(standInPort(`http://127.0.0.1:${hi}`)).toBe(hi - 1);
    expect(standInPort(new URL(`http://127.0.0.1:${hi}/api`), hi - 1, `ws://127.0.0.1:${hi - 2}/`)).toBe(hi - 3);
    expect(standInPort(`http://127.0.0.1:${lo}`)).toBe(hi);
    const all = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    expect(() => standInPort(...all)).toThrow(/stand-in/);
  });
});

// The turn-taking is checked on made-up ports, not on real ones of the spare range (2026-11-25): that range is where
// every other test file's fake servers take theirs at the same time, so the two ports 47970–47971 this case once
// listened on were both held by another worker's server now and then — 「no free port in 47970-47971」, and the retry
// too (自动打包 of Studio 0.9.82). The real listening below only asks what holds whatever else listens there.
describe("listenInStudioRange", () => {
  it("hands a port out again only once the rest of the range has been (a closed server's port met pooled keep-alive sockets, 2026-11-23)", () => {
    const ports = [1, 2, 3];
    const handed = new Set<number>();
    const got: number[] = [];
    for (let i = 0; i < 7; i++) {
      const port = portsInTurn(ports, handed)[0]!;
      noteHandedOut(handed, ports, port);
      got.push(port);
    }
    // A new round keeps the last one handed out in it, so the next server never gets the port just closed.
    expect(got).toEqual([1, 2, 3, 1, 2, 1, 3]);
    // Taken by someone else: the next not handed out, then any free one even if handed out before.
    expect(portsInTurn(ports, new Set([1]))).toEqual([2, 3, 1]);
    const all = new Set([1, 3]);
    noteHandedOut(all, ports, 2);
    expect([...all]).toEqual([2]);
  });

  it("listens on a free port of the spare range, a new one for each server while others of the range are free", async () => {
    const [lo, hi] = STUDIO_SPARE_PORTS;
    const got: number[] = [];
    for (let i = 0; i < 5; i++) {
      const server = createServer();
      const port = await listenInStudioRange(server);
      expect(server.address()).toMatchObject({ port });
      got.push(port);
      await new Promise((r) => server.close(r));
    }
    for (const port of got) expect(port >= lo && port <= hi).toBe(true);
    expect(new Set(got).size).toBe(got.length);
    // One still held is not handed out to the next.
    const holder = createServer();
    const held = await listenInStudioRange(holder);
    const other = createServer();
    expect(await listenInStudioRange(other)).not.toBe(held);
    await Promise.all([holder, other].map((s) => new Promise((r) => s.close(r))));
  });
});
