import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("registers a sandbox workspace and shows tasks on the board", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await expect(page.getByTestId("host-status")).toHaveText("Host 运行中");

  // Register through the UI (path input; the native folder picker is not driven in tests).
  const alpha = studio.workspace("alpha");
  await page.getByRole("button", { name: "+ 登记工作区" }).click();
  await page.getByLabel("工作区路径").fill(alpha);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  await expect(page.getByTestId("scope-ws-alpha")).toBeVisible();
  await expect(page.locator(".brand")).toContainText("alpha");

  // Tasks are created through the API here; the new-task page arrives in S1-10.
  const ws = (await studio.api<{ workspaces: Workspace[] }>("GET", "/api/state")).workspaces[0]!;
  const waiting = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "校验掉落表",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo check]]" },
  });
  const quiet = await studio.api<{ task: Task }>("POST", "/api/tasks", {
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "整理一下配置项命名" },
  });
  await studio.api("PATCH", `/api/tasks/${quiet.task.id}`, { column: "review" });

  await page.getByTestId("scope-all").click();
  const doing = page.getByTestId("column-doing");
  const review = page.getByTestId("column-review");
  await expect(doing.getByTestId("task-card")).toHaveCount(1);
  await expect(doing).toContainText("校验掉落表");
  await expect(doing).toContainText("待批准", { timeout: 30_000 });
  await expect(review).toContainText("整理一下配置项命名");
  await expect(review).toContainText("空闲", { timeout: 30_000 });
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await expect(page.getByTestId("column-todo")).toContainText("空");

  // Scope filter: nothing is cross-workspace yet.
  await page.getByTestId("scope-area").click();
  await expect(page.getByTestId("task-card")).toHaveCount(0);
  await page.getByTestId("scope-all").click();
  await expect(page.getByTestId("task-card")).toHaveCount(2);

  expect(waiting.session.kind).toBe("main");
  expect(await windowState(studio.app)).toMatchObject({ focused: false, anyFocused: false, onScreen: false });
  await screenshot(studio.app, "stage-1", "S1-09-board", page);
});

test("rejects a path that is not a directory", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page } = studio;
  await page.getByRole("button", { name: "+ 登记工作区" }).click();
  await page.getByLabel("工作区路径").fill(`${studio.root}\\does-not-exist`);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not a directory");
});
