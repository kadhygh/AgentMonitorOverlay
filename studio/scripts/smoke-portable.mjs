// S8-03 smoke of the portable zip, the way a person would meet it: unzip into a sandbox folder, first run (setup, keep
// the default data dir), start again, create a task, chat with the mock model, quit. Windows are test-mode windows
// (off-screen, never focused). Checks that nothing was written outside the sandbox folder (no Electron profile in
// %APPDATA%, no studio/.data). Never uses real models.
//   npm run package:portable && node scripts/smoke-portable.mjs release
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { MOCK_MODEL_CATALOG, removeTempDir, startMockAnthropic, startMockModel } from "../packages/testkit/dist/index.js";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(studio, process.argv[2] ?? "release");
const version = JSON.parse(readFileSync(join(studio, "package.json"), "utf8")).version;
const archive = join(releaseDir, `AMO-Studio-${version}-portable.zip`);
if (!existsSync(archive)) throw new Error(`${archive} not found: run npm run package:portable first`);

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-portable-"));
const results = { startedAt: new Date().toISOString(), archive: archive.replace(studio, "studio"), zipMB: Math.round(statSync(archive).size / 1024 / 1024), steps: [] };
const step = (name, data = {}) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data)}`);
};
const appdataElectron = join(process.env.APPDATA ?? "", "Electron");
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : null);
const before = { appdataElectron: mtime(join(appdataElectron, "Local Storage")), devData: mtime(join(studio, ".data")) };
const env = (extra = {}) => {
  const out = { ...process.env, AMO_STUDIO_TEST: "1", ...extra };
  delete out.AMO_STUDIO_DATA_DIR;
  delete out.AMO_STUDIO_PORTABLE_DIR;
  return out;
};

const mock = await startMockModel();
const claudeMock = await startMockAnthropic();
let app;
try {
  const t0 = Date.now();
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-x", "-f", archive, "-C", root], { stdio: "ignore" });
  const exe = join(root, "AMO Studio", "AMO Studio.exe");
  step("unzipped", { seconds: Math.round((Date.now() - t0) / 1000), exe: existsSync(exe) });

  // First run: setup with the default data dir.
  app = await _electron.launch({ executablePath: exe, args: [], env: env() });
  let page = await app.firstWindow();
  const defaultDir = await page.getByLabel("数据目录").inputValue();
  const closed = app.waitForEvent("close");
  await page.getByRole("button", { name: "开始使用" }).click();
  await closed;
  app = null;
  const config = JSON.parse(readFileSync(join(root, "AMO Studio", "amo-studio.json"), "utf8"));
  step("setup", { defaultIsNextToExe: defaultDir === join(root, "AMO Studio", "data"), saved: config });

  // Second run: the workbench, a task with the mock model, one reply.
  const mockEnv = { AMO_STUDIO_PORT: "0", AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl, AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG, AMO_STUDIO_TEST_CODEX_HOME: join(root, "codex-home"), AMO_STUDIO_TEST_CLAUDE_URL: claudeMock.baseUrl };
  mkdirSync(join(root, "codex-home"), { recursive: true });
  mkdirSync(join(root, "workspace"), { recursive: true });
  app = await _electron.launch({ executablePath: exe, args: [], env: env(mockEnv) });
  page = await app.firstWindow();
  await page.getByRole("button", { name: "+ 新任务" }).waitFor({ timeout: 60_000 });
  const dataDir = join(root, "AMO Studio", "data");
  const info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
  const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
  const api = async (method, path, body) => {
    const res = await fetch(`${info.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return res.json();
  };
  await api("POST", "/api/workspaces", { path: join(root, "workspace"), name: "smoke" });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("模型").selectOption({ label: "Claude · Mock Claude" });
  await page.getByLabel("第一句话").fill("你好，便携版");
  await page.getByRole("button", { name: "开始" }).click();
  await page.getByTestId("msg-agent").last().filter({ hasText: "MOCK: 你好，便携版" }).waitFor({ timeout: 60_000 });
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  const shot = join(studio, "screenshots", "stage-8", "S8-03-portable.png");
  mkdirSync(dirname(shot), { recursive: true });
  writeFileSync(shot, Buffer.from(png, "base64"));
  step("chat", { reply: "MOCK: 你好，便携版", dataEntries: readdirSync(dataDir).sort() });
  await app.close();
  app = null;

  const after = { appdataElectron: mtime(join(appdataElectron, "Local Storage")), devData: mtime(join(studio, ".data")) };
  step("nothing outside the folder", { appdataElectronUnchanged: after.appdataElectron === before.appdataElectron, devDataUnchanged: after.devData === before.devData, appdataStudio: existsSync(join(process.env.APPDATA ?? "", "amo-studio")) });
} catch (err) {
  step("failed", { error: String(err?.message ?? err).split(/\r?\n/)[0] });
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await mock.close();
  await claudeMock.close();
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(studio, "spikes", "results", "s8-03-portable-smoke.json"), JSON.stringify(results, null, 2));
  await new Promise((r) => setTimeout(r, 1500));
  removeTempDir(root);
}
