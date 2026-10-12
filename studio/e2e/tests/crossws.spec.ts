import { expect, test } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a cross-workspace task from creation to the canvas", async () => {
  studio = await launchStudio();
  const { page } = studio;
  for (const name of ["alpha", "beta"]) await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) });

  // Create it with the first session in beta.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("任务标题").fill("统一配置键名");
  await page.getByRole("group", { name: "任务范围" }).getByRole("button", { name: "跨工作区" }).click();
  await page.getByLabel("首个会话在").selectOption({ label: "beta" });
  await page.getByLabel("第一句话").fill("先列出两边的配置键");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先列出两边的配置键", { timeout: 30_000 });
  await expect(page.getByTestId("session-row")).toContainText("beta");
  await expect(page.getByTestId("thread-head")).toContainText("beta");

  // A second session in alpha.
  await page.getByLabel("所在工作区").selectOption({ label: "alpha" });
  await page.getByRole("button", { name: "+ 新会话" }).click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);
  await expect(page.getByTestId("session-row").nth(1)).toContainText("alpha");
  await expect(page.getByTestId("thread-head")).toContainText("alpha");

  // Board: the card lists both workspaces, in order of first use; the 跨工作区 scope holds it.
  await page.getByRole("button", { name: "← 看板" }).click();
  const where = "跨工作区（beta、alpha）";
  await expect(page.getByTestId("task-card")).toContainText(where);
  await page.getByTestId("scope-area").click();
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await page.getByTestId("scope-ws-alpha").click();
  await expect(page.getByTestId("task-card")).toHaveCount(0);

  // Canvas card, sidebar details and the agent view say the same.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const card = page.getByTestId("canvas-card");
  await expect(card).toContainText(where);
  await card.click();
  await expect(page.getByRole("group", { name: "任务详情" })).toContainText(where);
  await page.getByRole("tab", { name: "agent 视角" }).click();
  await expect(page.getByTestId("agent-view")).toContainText(where);
  await screenshot(studio.app, "stage-3", "S3-06-cross-workspace", page);
});
