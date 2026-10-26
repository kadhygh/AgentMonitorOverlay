import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 便签 in Studio since 2026-10-23: a program of its own (packages/notes; its window, pages and settings are tested in
// notes-app.spec.ts). Studio brings it up from the title bar — starting it when it is not running — hands it the
// pages Studio kept the first time, and 设置 → 便签 says whether it runs and opens it or its settings. In tests its
// home is in the test's data dir and Studio stops it when it closes.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const notesHome = (s: Studio) => join(s.dataDir, "notes-home");
const running = (s: Studio) => JSON.parse(readFileSync(join(notesHome(s), "running.json"), "utf8")) as { url: string; token: string; pid: number };
async function notesApi<T>(s: Studio, path: string): Promise<T> {
  const { url, token } = running(s);
  return (await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<T>;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the title bar's 便签 starts the 便签 program, which takes Studio's pages once; 设置 → 便签 opens it", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  // What Studio's own 便签 held before it became a program.
  await studio.api("PUT", "/api/scratchpad/pages/1", { text: "Studio 里记的要点" });

  // Not started by Studio in tests until asked; 设置 → 便签 says so.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "便签" }).click();
  const section = dialog.getByTestId("notes-link");
  await expect(section.getByTestId("notes-link-state")).toHaveText("没有在运行");
  await expect(section.getByTestId("notes-start")).toBeVisible();
  await page.keyboard.press("Escape");

  // The title bar's 便签: the program starts and shows, with Studio's pages.
  await page.getByTestId("open-scratchpad").click();
  await expect.poll(() => existsSync(join(notesHome(studio!), "running.json")), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await notesApi<{ pages: Array<{ text: string }> }>(studio!, "/api/scratchpad")).pages[0]?.text, { timeout: 15_000 }).toBe("Studio 里记的要点");
  const info = await notesApi<{ settings: { importedAt: string | null } }>(studio, "/api/notes");
  expect(info.settings.importedAt).not.toBeNull();
  const pid = running(studio).pid;
  expect(alive(pid)).toBe(true);

  // Again: the same program, not another one; the pages are not taken twice.
  await studio.api("PUT", "/api/scratchpad/pages/1", { text: "Studio 里后来改的" });
  await page.getByTestId("open-scratchpad").click();
  await page.waitForTimeout(500);
  expect(running(studio).pid).toBe(pid);
  expect((await notesApi<{ pages: Array<{ text: string }> }>(studio, "/api/scratchpad")).pages[0]?.text).toBe("Studio 里记的要点");

  // 设置 → 便签 now: running, with its shortcut, and the buttons to it.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "便签" }).click();
  await expect(section.getByTestId("notes-link-state")).toHaveText("运行中");
  await expect(section).toContainText("快捷键 Ctrl + Shift + F12");
  await expect(section.getByRole("button", { name: "显示便签" })).toBeVisible();
  await expect(section.getByRole("button", { name: "打开便签设置" })).toBeVisible();
  await screenshot(app, "stage-14", "S14-B-scratchpad-settings", page);

  // Tests stop the program with Studio (for the person it keeps running).
  await studio.close();
  studio = undefined;
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
});
