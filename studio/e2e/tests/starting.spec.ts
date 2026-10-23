import { expect, test, type Route } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 正在启动 (2026-10-23): starting a session waits for the model's process; the page it starts in is covered with a
// spinner meanwhile (nothing there clicked or typed twice), and uncovered once the session is there or failed.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** Holds the matching POSTs for `ms` (a slow start), or answers them with an error. */
function slowPost(ms: number, fail = false) {
  return async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, ms));
    if (fail) return route.fulfill({ status: 500, json: { error: { code: "internal", message: "模拟：启动失败" } } });
    return route.continue();
  };
}

test("开始 and 开始新会话 cover the page with a spinner while the session starts", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });

  // A new task: the draft page is covered, with the model's name, until the task page opens.
  await app.context().route("**/api/tasks", slowPost(1500));
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "模型" }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  await page.getByLabel("第一句话").fill("先看看目录");
  await page.getByRole("button", { name: "开始" }).click();
  const cover = page.getByTestId("starting-cover");
  await expect(cover).toContainText("正在启动 Mock 模型…");
  await screenshot(app, "stage-18", "S24-starting-cover", page);
  await expect(page.getByTestId("task-title")).toHaveText("先看看目录", { timeout: 30_000 });
  await expect(cover).toHaveCount(0);
  await expect(page.getByTestId("msg-user")).toHaveText(/先看看目录/);

  // A new session in the task: the conversation column is covered, the session list beside it is not.
  await app.context().route("**/api/tasks/*/sessions", slowPost(1500));
  await page.getByTestId("sessions-toggle").click();
  await page.getByTestId("new-session-toggle").click();
  await page.getByRole("button", { name: "开始新会话" }).click();
  await expect(page.locator(".thread-col").getByTestId("starting-cover")).toContainText("正在启动");
  await expect(page.getByTestId("session-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(cover).toHaveCount(0);
  await expect(page.getByTestId("session-row").nth(1)).toHaveAttribute("aria-current", "true");

  // A start that fails: uncovered again, the error said, nothing new.
  await app.context().unroute("**/api/tasks/*/sessions");
  await app.context().route("**/api/tasks/*/sessions", slowPost(600, true));
  await page.getByTestId("new-session-toggle").click();
  await page.getByRole("button", { name: "开始新会话" }).click();
  await expect(cover).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("模拟：启动失败");
  await expect(cover).toHaveCount(0);
  await expect(page.getByTestId("session-row")).toHaveCount(2);
});
