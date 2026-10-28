import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

// The Studio tray (2026-10-29, the user): × only hides the workbench (Studio and the Host stay, sessions go on); the
// tray's 打开 Studio brings it back; 完全退出 stops the Host too, asking first when sessions are at work. A Host stopped
// from elsewhere (the AMO platform's 重启 Studio: POST /api/shutdown) takes the shell with it. Tests have no tray icon:
// its menu is reached through __studioTray / __studioTrayClick, and 完全退出's question is answered from __amoQuitAnswers.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close().catch(() => undefined);
  studio = undefined;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const tray = (s: Studio) => s.app.evaluate(() => (globalThis as { __studioTray?: () => string[] }).__studioTray!());
const trayClick = (s: Studio, label: string) => s.app.evaluate((_e, l) => (globalThis as { __studioTrayClick?: (l: string) => void }).__studioTrayClick!(l), label);
const health = async (s: Studio) => {
  const { url } = JSON.parse(readFileSync(join(s.dataDir, "host.json"), "utf8")) as { url: string };
  return (await (await fetch(`${url}/api/health`)).json()) as { ok: boolean; pid: number; running: number; version: string };
};

test("× hides the workbench while Studio and the Host keep running; 打开 Studio brings it back; 完全退出 asks while a session is at work, then everything ends", async () => {
  studio = await launchStudio();
  const s = studio;
  const { page, app, dataDir } = s;
  await expect(page.getByTestId("host-status")).toHaveText("Host 运行中");
  const shellPid = await app.evaluate(() => process.pid);
  const first = await health(s);
  // The Host says the Studio that started it ("dev" from the sources), and the shell where it is (for the platform).
  expect(first).toMatchObject({ ok: true, running: 0, version: "dev" });
  const hostPid = first.pid;
  expect(JSON.parse(readFileSync(join(dataDir, "shell.json"), "utf8"))).toMatchObject({ pid: shellPid, version: "dev" });
  expect(await tray(s)).toEqual(["打开 Studio", "—", "完全退出"]);

  // ---- ×: the window is hidden, not closed; the app and the Host go on.
  await page.getByRole("group", { name: "窗口" }).getByRole("button", { name: "关闭" }).click();
  await expect.poll(async () => (await windowState(app)).visible).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().includes("#")).length)).toBe(1);
  expect(alive(shellPid)).toBe(true);
  expect(alive(hostPid)).toBe(true);
  expect((await health(s)).ok).toBe(true);
  // ---- 打开 Studio: back (shown without taking focus, as test windows are).
  await trayClick(s, "打开 Studio");
  await expect.poll(async () => (await windowState(app)).visible).toBe(true);
  expect(await windowState(app)).toMatchObject({ focused: false, onScreen: false });
  await expect(page.getByTestId("host-status")).toHaveText("Host 运行中");
  await screenshot(app, "studio", "tray-window-back", page);

  // ---- a session at work ([[wait]]: the mock says nothing for 8 s): 完全退出 asks, 取消 leaves everything running.
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("tray") });
  await s.api<{ task: Task }>("POST", "/api/tasks", { title: "跑着的", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "慢一点 [[wait]]" } });
  await expect.poll(async () => (await health(s)).running, { timeout: 10_000 }).toBe(1);
  await trayClick(s, "完全退出");
  const asked = () => app.evaluate(() => (globalThis as { __amoQuitAsked?: Array<{ message: string; detail: string; yes: string }> }).__amoQuitAsked ?? []);
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({ message: "有 1 个会话正在进行，完全退出会中断它。", yes: "中断会话并退出" });
  expect((await asked())[0]!.detail).toContain("点窗口右上角的 ×");
  await new Promise((r) => setTimeout(r, 300));
  expect(alive(hostPid)).toBe(true);
  expect((await health(s)).running).toBe(1);
  expect(existsSync(join(dataDir, "host-exit.json"))).toBe(false);

  // ---- asked again and agreed: the Host stops (the session cut), then the app — no process of either is left.
  await app.evaluate(() => ((globalThis as { __amoQuitAnswers?: boolean[] }).__amoQuitAnswers = [true]));
  const closed = app.waitForEvent("close");
  await trayClick(s, "完全退出");
  await closed;
  await expect.poll(() => alive(hostPid), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => alive(shellPid), { timeout: 15_000 }).toBe(false);
  expect(JSON.parse(readFileSync(join(dataDir, "host-exit.json"), "utf8"))).toMatchObject({ pid: hostPid, reason: "shutdown" });
  expect(existsSync(join(dataDir, "host.json"))).toBe(false);
  expect(existsSync(join(dataDir, "host.lock"))).toBe(false);
  expect(existsSync(join(dataDir, "shell.json"))).toBe(false);
});

test("完全退出 with nothing at work asks nothing; a Host stopped from elsewhere (the platform's 重启 Studio) takes the shell with it", async () => {
  // Nothing at work: 完全退出 goes straight through.
  studio = await launchStudio({ mockModel: false });
  const s = studio;
  await expect(s.page.getByTestId("host-status")).toHaveText("Host 运行中");
  const hostPid = (await health(s)).pid;
  const closed = s.app.waitForEvent("close");
  await trayClick(s, "完全退出");
  await closed;
  await expect.poll(() => alive(hostPid), { timeout: 15_000 }).toBe(false);
  await s.close();

  // The platform's way: POST /api/shutdown with the data dir's token (no `interrupt`); the shell sees host-exit.json
  // at its next look (every 500 ms here) and quits instead of starting the Host again.
  studio = await launchStudio({ mockModel: false, env: { AMO_STUDIO_KEEPALIVE_MS: "500" } });
  const t = studio;
  await expect(t.page.getByTestId("host-status")).toHaveText("Host 运行中");
  const pid = (await health(t)).pid;
  const shellPid = await t.app.evaluate(() => process.pid);
  const gone = t.app.waitForEvent("close");
  expect(await t.api("POST", "/api/shutdown", {})).toEqual({ ok: true, running: 0 });
  await gone;
  await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => alive(shellPid), { timeout: 15_000 }).toBe(false);
  expect(existsSync(join(t.dataDir, "shell.json"))).toBe(false);
});
