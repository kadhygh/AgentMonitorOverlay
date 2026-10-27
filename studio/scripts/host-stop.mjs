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
// 2026-10-27: taskkill fails when one process of the tree cannot be ended; that is reported, and the files are
// cleared only once the Host itself is gone (a Host left running keeps its data dir).
let failed = "";
try {
  execFileSync("taskkill", ["/pid", String(info.pid), "/T", "/F"], { stdio: "pipe", encoding: "utf8" });
} catch (err) {
  failed = String(err.stderr || err.message || err).trim();
}
const running = (() => {
  try {
    process.kill(Number(info.pid), 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
})();
if (running) {
  console.error(`Could not stop the Host (pid ${info.pid}): ${failed || "it is still running"}`);
  process.exit(1);
}
rmSync(infoFile, { force: true });
rmSync(join(dataDir, "host.lock"), { force: true });
console.log(`Stopped AMO Studio Host (pid ${info.pid}) and its app-servers.${failed ? ` (Some of its processes could not be ended: ${failed.split("\n")[0]})` : ""}`);
