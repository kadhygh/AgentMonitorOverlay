// How long a long session takes to open, and what it costs the window (2026-10-24, before and after drawing only a long
// session's last turns). Copies the items of real sessions (read-only) into a sandbox Studio's tasks, then, after a
// warm-up, opens task A, task B, A again, and streams a reply into A. Times run from the click until the conversation
// stops changing; also the window's long tasks, JS heap and element count. Mock models only; the sandbox is removed.
//   npm run build && node scripts/bench-session-open.mjs --from .data/studio.db --sessions <idA>,<idB> [--view standard] [--runs 3]
//   BENCH_TRACE=1 also prints the API requests of each opening.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { MOCK_MODEL_CATALOG, removeTempDir, startMockAnthropic, startMockModel } from "../packages/testkit/dist/index.js";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const from = resolve(studio, arg("from", ".data/studio.db"));
const sessions = arg("sessions", "").split(",").filter(Boolean);
const view = arg("view", "standard");
const runs = Number(arg("runs", "3"));
if (sessions.length !== 2) throw new Error("--sessions <idA>,<idB>");
const electronPath = createRequire(import.meta.url)("electron");

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "bench-open-"));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(root, "codex-home"), { recursive: true });
mkdirSync(join(root, "ws"), { recursive: true });

const mock = await startMockModel();
const claudeMock = await startMockAnthropic();
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AMO_STUDIO_|CLAUDE|ANTHROPIC_)/.test(k))),
  AMO_STUDIO_TEST: "1",
  AMO_STUDIO_DATA_DIR: dataDir,
  AMO_STUDIO_PORT: "0",
  AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl,
  AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG,
  AMO_STUDIO_TEST_CODEX_HOME: join(root, "codex-home"),
  AMO_STUDIO_TEST_CLAUDE_URL: claudeMock.baseUrl,
};
const launch = async () => {
  const app = await _electron.launch({ executablePath: electronPath, args: ["--js-flags=--expose-gc", join(studio, "packages", "app", "dist", "main.js")], env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
};
const api = async (method, path, body) => {
  const info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
  const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
  const res = await fetch(`${info.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return res.json();
};

/** Clicks the task and waits until the conversation has not changed for a second. */
async function open(page, title) {
  await page.evaluate(() => {
    const w = window;
    w.__bench = { start: performance.now(), last: performance.now(), long: 0 };
    w.__benchObs?.disconnect();
    w.__benchObs = new MutationObserver(() => (w.__bench.last = performance.now()));
    w.__benchObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    w.__benchLong?.disconnect();
    w.__benchLong = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__bench.long += e.duration;
    });
    w.__benchLong.observe({ type: "longtask" });
  });
  const requests = [];
  const t0 = Date.now();
  const onDone = (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) requests.push(`${u.pathname.replace(/[a-z]+-[0-9a-f-]{8,}/g, ":id")}@${r.timing().startTime ? Math.round(r.timing().startTime - t0) : "?"}+${Math.round(r.timing().responseEnd)}`);
  };
  page.on("requestfinished", onDone);
  await page.getByTestId("task-card").filter({ hasText: title }).first().click();
  await page.getByTestId("thread-head").waitFor({ timeout: 120_000 });
  const headAt = Date.now() - t0;
  for (;;) {
    await page.waitForTimeout(250);
    const quiet = await page.evaluate(() => performance.now() - window.__bench.last);
    if (quiet > 1000) break;
  }
  page.off("requestfinished", onDone);
  if (process.env.BENCH_TRACE) console.log(title, { headAt, requests });
  return page.evaluate(() => {
    const b = window.__bench;
    window.gc?.();
    return { ms: Math.round(b.last - b.start), longTaskMs: Math.round(b.long), heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), domNodes: document.getElementsByTagName("*").length };
  });
}
const back = async (page) => {
  await page.getByRole("button", { name: /返回看板|看板/ }).first().click();
  await page.getByTestId("task-card").first().waitFor();
  await page.waitForTimeout(500);
};

let app;
const results = [];
try {
  // The sandbox: two tasks with a mock session each.
  ({ app } = await launch());
  const ws = await api("POST", "/api/workspaces", { path: join(root, "ws"), name: "bench" });
  const made = [];
  for (const title of ["bench-A", "bench-B"]) made.push((await api("POST", "/api/tasks", { title, workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hi" } })).session.id);
  await new Promise((r) => setTimeout(r, 3000));
  await app.close();
  app = null;

  // Their items become the real sessions' (read-only copy).
  const src = new DatabaseSync(from, { readOnly: true });
  const dst = new DatabaseSync(join(dataDir, "studio.db"));
  const counts = [];
  dst.exec("BEGIN");
  for (const [i, real] of sessions.entries()) {
    dst.prepare("DELETE FROM items WHERE session_id = ?").run(made[i]);
    const insert = dst.prepare("INSERT INTO items (session_id, seq, id, type, created_at, body) VALUES (?, ?, ?, ?, ?, ?)");
    const rows = src.prepare("SELECT seq, id, type, created_at, body FROM items WHERE session_id = ? ORDER BY seq").all(real);
    for (const r of rows) insert.run(made[i], r.seq, r.id, r.type, r.created_at, r.body);
    counts.push({ items: rows.length, MB: +(rows.reduce((n, r) => n + r.body.length, 0) / 1048576).toFixed(1) });
  }
  dst.exec("COMMIT");
  src.close();
  dst.close();
  console.log(`sessions: ${JSON.stringify(counts)}, view ${view}`);

  for (let run = 1; run <= runs; run++) {
    const l = await launch();
    app = l.app;
    const { page } = l;
    await page.evaluate((v) => localStorage.setItem("amo.transcriptView", v), view);
    await page.reload();
    await page.getByTestId("task-card").first().waitFor({ timeout: 60_000 });
    // Warm-up: Studio's first task page asks the model list, git and the like once; not the session's cost.
    await open(page, "bench-B");
    await back(page);
    const a1 = await open(page, "bench-A");
    await back(page);
    const b = await open(page, "bench-B");
    await back(page);
    const a2 = await open(page, "bench-A");
    // A reply streaming into the long session (40 chunks, 150 ms apart): the window's busy time meanwhile.
    const streamed = await page.evaluate(() => {
      window.__bench.long = 0;
      window.__bench.start = performance.now();
      return true;
    });
    await api("POST", `/api/sessions/${made[0]}/messages`, { text: "[[slow]]" });
    await page.getByTestId("msg-agent").filter({ hasText: /slow slow slow/ }).last().waitFor({ timeout: 60_000 }).catch(() => undefined);
    for (;;) {
      await page.waitForTimeout(250);
      if (await page.evaluate(() => performance.now() - window.__bench.last > 1000)) break;
    }
    const stream = streamed && (await page.evaluate(() => ({ ms: Math.round(window.__bench.last - window.__bench.start), longTaskMs: Math.round(window.__bench.long) })));
    // The Host's part (after the opens, so it does not warm them): reading the items and sending them.
    const t0 = performance.now();
    const items = await api("GET", `/api/sessions/${made[0]}/items`);
    const fetchMs = Math.round(performance.now() - t0);

    const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().filter((m) => m.type === "Tab").map((m) => Math.round(m.memory.workingSetSize / 1024)));
    const row = { run, fetchA: { ms: fetchMs, items: items.length }, "A first": a1, B: b, "A again": a2, stream, rendererMB: metrics };
    results.push(row);
    console.log(JSON.stringify(row));
    await app.close();
    app = null;
  }
  const median = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  console.log(`stream into A: median ${median(results.map((r) => r.stream.ms))} ms, long tasks ${median(results.map((r) => r.stream.longTaskMs))} ms`);
  for (const k of ["A first", "B", "A again"]) console.log(`${k}: median ${median(results.map((r) => r[k].ms))} ms, long tasks ${median(results.map((r) => r[k].longTaskMs))} ms, heap ${median(results.map((r) => r[k].heapMB))} MB, DOM ${median(results.map((r) => r[k].domNodes))}`);
} finally {
  await app?.close().catch(() => undefined);
  await mock.close();
  await claudeMock.close();
  await new Promise((r) => setTimeout(r, 1000));
  try {
    removeTempDir(root);
  } catch {
    execFileSync("cmd", ["/c", "rmdir", "/s", "/q", root], { stdio: "ignore" });
  }
}
