import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostAlreadyRunningError, startHost } from "./host-process.js";

// Command-line entry: `node packages/host/dist/bin.js`. The Electron shell starts it the same way (S1-08).
// Env: AMO_STUDIO_DATA_DIR (default studio/.data), AMO_STUDIO_PORT (default 47900), AMO_STUDIO_UI_DIR,
// AMO_STUDIO_DEV_ORIGIN (allowed CORS origin for the Vite dev server).

const studioRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const dataDir = process.env.AMO_STUDIO_DATA_DIR ?? join(studioRoot, ".data");

try {
  const host = await startHost({
    dataDir,
    ...(process.env.AMO_STUDIO_PORT ? { port: Number(process.env.AMO_STUDIO_PORT) } : {}),
    ...(process.env.AMO_STUDIO_UI_DIR ? { uiDir: process.env.AMO_STUDIO_UI_DIR } : {}),
    ...(process.env.AMO_STUDIO_DEV_ORIGIN ? { allowedOrigins: [process.env.AMO_STUDIO_DEV_ORIGIN] } : {}),
  });
  console.log(`AMO Studio Host listening on ${host.info.url} (data: ${dataDir})`);
  const stop = (keepServers: boolean) => {
    void host.shutdown({ keepServers }).then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop(false));
  process.on("SIGTERM", () => stop(false));
  // Over an IPC channel the shell can ask for a plain shutdown or a restart that keeps app-servers (and sessions) alive.
  process.on("message", (msg) => {
    if (msg === "shutdown") stop(false);
    if (msg === "restart") stop(true);
  });
} catch (err) {
  if (err instanceof HostAlreadyRunningError) {
    console.error(err.message);
    process.exit(3);
  }
  console.error(err);
  process.exit(1);
}
