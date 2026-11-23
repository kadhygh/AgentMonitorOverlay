import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { listenInStudioRange, STUDIO_SPARE_PORTS, standInPort } from "./ports.js";

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

describe("listenInStudioRange", () => {
  it("hands a port out again only once the rest of the range has been (a closed server's port met pooled keep-alive sockets, 2026-11-23)", async () => {
    // Two ports of the spare range: one server after another, each closed before the next, take turns.
    const range = [STUDIO_SPARE_PORTS[0] + 20, STUDIO_SPARE_PORTS[0] + 21] as const;
    const got: number[] = [];
    for (let i = 0; i < 6; i++) {
      const server = createServer();
      got.push(await listenInStudioRange(server, "127.0.0.1", range));
      await new Promise((r) => server.close(r));
    }
    for (let i = 1; i < got.length; i++) expect(got[i]).not.toBe(got[i - 1]);
    // Taken by someone else: any free one, handed out before or not.
    const holder = createServer();
    const held = await listenInStudioRange(holder, "127.0.0.1", range);
    const other = createServer();
    expect(await listenInStudioRange(other, "127.0.0.1", range)).toBe(held === range[0] ? range[1] : range[0]);
    await Promise.all([holder, other].map((s) => new Promise((r) => s.close(r))));
  });
});
