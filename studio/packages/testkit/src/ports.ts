import type { Server } from "node:net";

// LOOP_RULES red line 6: Studio listens only on 47900–47999. Servers that would otherwise take any free port (tests,
// mocks, a Host started with port 0) take a free one in 47950–47999 instead; Codex app-servers use 47910–47949 and the
// Host itself defaults to 47900. (Kept in sync with the copy in the other package: host does not depend on testkit at
// runtime, and testkit must not depend on host.)

export const STUDIO_SPARE_PORTS: readonly [number, number] = [47950, 47999];

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
