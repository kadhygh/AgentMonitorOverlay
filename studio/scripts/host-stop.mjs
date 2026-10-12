// Stops the resident Host of a data dir (default studio/.data) together with the app-servers it started.
//   npm run host:stop            (or AMO_STUDIO_DATA_DIR=... node scripts/host-stop.mjs)
// The pid comes from host.json and is only killed when its command line is our Host (pids get reused).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.AMO_STUDIO_DATA_DIR ?? join(studioRoot, ".data");
const infoFile = join(dataDir, "host.json");
if (!existsSync(infoFile)) {
  console.log(`No Host is running for ${dataDir}.`);
  process.exit(0);
}
const info = JSON.parse(readFileSync(infoFile, "utf8"));
const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(info.pid)}").CommandLine`;
const commandLine = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
if (!commandLine.replaceAll("\\", "/").includes("packages/host/dist/bin.js")) {
  console.log(`pid ${info.pid} is not an AMO Studio Host any more; clearing stale files.`);
  rmSync(infoFile, { force: true });
  rmSync(join(dataDir, "host.lock"), { force: true });
  process.exit(0);
}
execFileSync("taskkill", ["/pid", String(info.pid), "/T", "/F"], { stdio: "ignore" });
rmSync(infoFile, { force: true });
rmSync(join(dataDir, "host.lock"), { force: true });
console.log(`Stopped AMO Studio Host (pid ${info.pid}) and its app-servers.`);
