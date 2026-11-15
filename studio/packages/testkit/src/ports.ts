import type { Server } from "node:net";

// LOOP_RULES red line 6: Studio listens only on 47900–47999. Servers that would otherwise take any free port (tests,
// mocks, a Host started with port 0) take a free one in 47950–47999 instead; Codex app-servers use 47910–47949 and the
// Host itself defaults to 47900. (Kept in sync with the copy in the other package: host does not depend on testkit at
// runtime, and testkit must not depend on host.)

export const STUDIO_SPARE_PORTS: readonly [number, number] = [47950, 47999];

/**
 * A port for an address a test only pretends something listens on (it answers the requests to it itself — a routed
 * fetch, a host.json nobody connects to): the highest of the range that none of `taken` has, where `taken` are the
 * servers the test really talks to (their urls or ports). A port written by hand in that range is taken by such a
 * server one run in 50 (2026-11-16: platform.test.ts's stand-in Host at a fixed 47999 answered the fake team server's
 * own requests, and 自动打包 stopped on it twice); scripts/test-ports.test.mjs refuses one.
 */
export function standInPort(...taken: Array<number | string | URL>): number {
  const used = new Set(taken.map((t) => (typeof t === "number" ? t : Number(new URL(String(t)).port))));
  for (let port = STUDIO_SPARE_PORTS[1]; port >= STUDIO_SPARE_PORTS[0]; port--) if (!used.has(port)) return port;
  throw new Error("no port left for a stand-in: every port of the spare range is taken");
}

/** Listens on a free port of the range (random start, then the next ones) and returns it. */
export async function listenInStudioRange(server: Server, host = "127.0.0.1", range: readonly [number, number] = STUDIO_SPARE_PORTS): Promise<number> {
  const [lo, hi] = range;
  const count = hi - lo + 1;
  const first = Math.floor(Math.random() * count);
  for (let i = 0; i < count; i++) {
    const port = lo + ((first + i) % count);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    }
  }
  throw new Error(`no free port in ${lo}-${hi}`);
}
