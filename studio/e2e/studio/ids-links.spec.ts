import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { DEMO_FILE, DEMO_FILE_TEXT } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// S18 (2026-10-18): the task's and the session's id show short and copy whole on a click; a file a reply names from
// inside the project (`importer.py:4` for tools/py/importer.py) is a link that opens the viewer at its line.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const lastCopied = (app: ElectronApplication) => app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1));

async function nextWindow(app: ElectronApplication, act: () => Promise<void>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

test("ids copy on a click; a file named from inside a git project opens at its line", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const dir = studio.workspace("nested");
  mkdirSync(join(dir, "tools", "py"), { recursive: true });
  writeFileSync(join(dir, "tools", "py", DEMO_FILE), DEMO_FILE_TEXT);
  execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "-A"], { cwd: dir, windowsHide: true });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "看 id 和文件",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[files]] 入口在哪" },
  });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").filter({ hasText: "入口在" });
  await expect(reply).toBeVisible({ timeout: 60_000 });

  // `importer.py:4` is not at the project's top: the one file whose path ends with it.
  const link = reply.getByTestId("file-link").filter({ hasText: "importer.py:4" });
  await expect(link).toHaveAttribute("data-path", join(dir, "tools", "py", DEMO_FILE));
  const viewer = await nextWindow(app, () => link.click());
  await expect(viewer.getByTestId("viewer-name")).toHaveText(DEMO_FILE);
  await expect(viewer.locator(".gr-line.marked")).toHaveAttribute("data-line", "new:4");

  // Ids: short on the page, the whole id copied.
  const taskId = page.getByTestId("task-id");
  const sessionId = page.getByTestId("session-id");
  await expect(taskId).toHaveText(`#${task.id.split("-")[1]}`);
  await expect(sessionId).toHaveText(`#${session.id.split("-")[1]}`);
  await expect(taskId).toHaveAttribute("title", new RegExp(task.id));
  await page.bringToFront();
  await taskId.hover();
  await screenshot(app, "stage-18", "S18-ids", page);
  await taskId.click();
  await expect.poll(() => lastCopied(app)).toBe(task.id);
  await expect(taskId).toHaveText("已复制");
  await sessionId.click();
  await expect.poll(() => lastCopied(app)).toBe(session.id);
  await expect(sessionId).toHaveText("已复制");
  await expect(taskId).toHaveText(`#${task.id.split("-")[1]}`, { timeout: 5_000 });
});
