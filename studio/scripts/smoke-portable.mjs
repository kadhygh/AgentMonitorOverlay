// S8-03 smoke of the portable zips, the way a person would meet them: unzip each into a sandbox folder and run it.
//   AMO Studio: first run (setup, keep the default data dir), start again; it ships no Claude Code and finds the
//     person's own (with none here, the SDK's copy of the source checkout stands in); create a task, chat with the mock model,
//     bring up its 便签 (AMO Studio.exe --amo-app=notes), quit; nothing written outside the sandbox folder (no Electron
//     profile in %APPDATA%, no studio/.data).
//   AMO Reviewer: started with a git folder it reviews its changes.
//   AMO Notes: starts and answers.
// Windows are test-mode windows (off-screen, never focused); homes are in the sandbox. Never uses real models.
//   npm run package:portable && node scripts/smoke-portable.mjs release
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { MOCK_MODEL_CATALOG, removeTempDir, startMockAnthropic, startMockModel } from "../packages/testkit/dist/index.js";
import { TOOLS, toolVersion } from "./amo-tools.mjs";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(studio, process.argv[2] ?? "release");
// Each tool's zip carries its own version (scripts/amo-tools.mjs).
const archives = Object.fromEntries(["studio", "reviewer", "notes"].map((id) => [TOOLS[id].zip.slice(4), join(releaseDir, `${TOOLS[id].zip}-${toolVersion(id)}-portable.zip`)]));
for (const a of Object.values(archives)) if (!existsSync(a)) throw new Error(`${a} not found: run npm run package:portable first`);

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-portable-"));
const results = { startedAt: new Date().toISOString(), zipMB: Object.fromEntries(Object.entries(archives).map(([n, a]) => [n, Math.round(statSync(a).size / 1024 / 1024)])), steps: [] };
const step = (name, data = {}) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data)}`);
};
const appdataElectron = join(process.env.APPDATA ?? "", "Electron");
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : null);
const before = { appdataElectron: mtime(join(appdataElectron, "Local Storage")), devData: mtime(join(studio, ".data")) };
const env = (extra = {}) => {
  const out = { ...process.env, AMO_STUDIO_TEST: "1", ...extra };
  for (const k of Object.keys(out)) if (/^(AMO_STUDIO_DATA_DIR|AMO_STUDIO_PORTABLE_DIR|AMO_NOTES_|AMO_REVIEWER_|CLAUDE|ANTHROPIC_)/.test(k) && !(k in extra)) delete out[k];
  return out;
};
const unzip = (archive) => execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-x", "-f", archive, "-C", root], { stdio: "ignore" });
const until = async (what, check, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const exePath = (pid) => execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`], { encoding: "utf8", windowsHide: true }).trim();

const mock = await startMockModel();
const claudeMock = await startMockAnthropic();
let app;
try {
  // —— AMO Studio ——
  const t0 = Date.now();
  unzip(archives.Studio);
  const exe = join(root, "AMO Studio", "AMO Studio.exe");
  step("studio unzipped", { seconds: Math.round((Date.now() - t0) / 1000), exe: existsSync(exe) });

  // First run: setup with the default data dir.
  app = await _electron.launch({ executablePath: exe, args: [], env: env() });
  let page = await app.firstWindow();
  const defaultDir = await page.getByLabel("数据目录").inputValue();
  const closed = app.waitForEvent("close");
  await page.getByRole("button", { name: "开始使用" }).click();
  await closed;
  app = null;
  const config = JSON.parse(readFileSync(join(root, "AMO Studio", "amo-studio.json"), "utf8"));
  step("studio setup", { defaultIsNextToExe: defaultDir === join(root, "AMO Studio", "data"), saved: config });

  // Second run: the workbench, a task with the mock model, one reply.
  const shipped = existsSync(join(root, "AMO Studio", "resources", "app", "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64"));
  const home = process.env.USERPROFILE ?? "";
  const ownClaude = [...(process.env.PATH ?? "").split(";").filter(Boolean).map((d) => join(d, "claude.exe")), join(home, ".local", "bin", "claude.exe")].some((p) => existsSync(p));
  const sdkClaude = join(studio, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe");
  const mockEnv = {
    ...(ownClaude ? {} : { AMO_STUDIO_CLAUDE: sdkClaude }), AMO_STUDIO_PORT: "0", AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl, AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG, AMO_STUDIO_TEST_CODEX_HOME: join(root, "codex-home"), AMO_STUDIO_TEST_CLAUDE_URL: claudeMock.baseUrl };
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
  const claudeCode = await api("GET", "/api/claude-code");
  step("studio Claude Code", { shipsClaudeCode: shipped, runsOn: claudeCode.source, version: claudeCode.version });
  if (shipped || !claudeCode.path) throw new Error("the Studio zip must not ship Claude Code, and must find the person's");
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click();
  await page.getByLabel("第一句话").fill("你好，便携版");
  await page.getByRole("button", { name: "开始" }).click();
  await page.getByTestId("msg-agent").last().filter({ hasText: "MOCK: 你好，便携版" }).waitFor({ timeout: 60_000 });
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  const shot = join(studio, "screenshots", "stage-8", "S8-03-portable.png");
  mkdirSync(dirname(shot), { recursive: true });
  writeFileSync(shot, Buffer.from(png, "base64"));
  step("studio chat", { reply: "MOCK: 你好，便携版", dataEntries: readdirSync(dataDir).sort() });

  // Its 便签: the same exe, told which program to run.
  await page.getByTestId("open-scratchpad").click();
  const notesInStudio = await until("the 便签 of AMO Studio", async () => {
    const r = readJson(join(dataDir, "notes-home", "running.json"));
    if (!r) return null;
    const res = await fetch(`${r.url}/api/notes`, { headers: { authorization: `Bearer ${r.token}` } }).catch(() => null);
    return res?.ok ? r : null;
  });
  step("studio 便签", { answers: true, exe: exePath(notesInStudio.pid) === exe });
  await app.close();
  app = null;

  const after = { appdataElectron: mtime(join(appdataElectron, "Local Storage")), devData: mtime(join(studio, ".data")) };
  step("studio: nothing outside the folder", { appdataElectronUnchanged: after.appdataElectron === before.appdataElectron, devDataUnchanged: after.devData === before.devData, appdataStudio: existsSync(join(process.env.APPDATA ?? "", "amo-studio")) });

  // —— AMO Reviewer ——
  unzip(archives.Reviewer);
  const repo = join(root, "game");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "ignore", windowsHide: true });
  git("init", "-q");
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.1\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.25\n");
  const reviewerHome = join(root, "reviewer-home");
  app = await _electron.launch({ executablePath: join(root, "AMO Reviewer", "AMO Reviewer.exe"), args: [repo], env: env({ AMO_REVIEWER_TEST: "1", AMO_REVIEWER_HOME: reviewerHome }) });
  const review = await until("the Reviewer's window", () => app.windows().find((w) => w.url().includes("reviewer.html#review")));
  await review.getByTestId("review-file-head").filter({ hasText: "drop.lua" }).waitFor({ timeout: 30_000 });
  step("reviewer", { reviews: "drop.lua", data: existsSync(join(reviewerHome, "data", "studio.db")) });
  await app.close();
  app = null;

  // —— AMO Notes ——
  unzip(archives.Notes);
  const notesHome = join(root, "notes-home");
  app = await _electron.launch({ executablePath: join(root, "AMO Notes", "AMO Notes.exe"), args: [], env: env({ AMO_NOTES_TEST: "1", AMO_NOTES_HOME: notesHome }) });
  const notes = await until("AMO Notes", async () => {
    const r = readJson(join(notesHome, "running.json"));
    if (!r) return null;
    const res = await fetch(`${r.url}/api/notes`, { headers: { authorization: `Bearer ${r.token}` } }).catch(() => null);
    return res?.ok ? await res.json() : null;
  });
  step("notes", { answers: true, shortcut: notes.settings?.shortcut ?? null });
  await app.close();
  app = null;
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
