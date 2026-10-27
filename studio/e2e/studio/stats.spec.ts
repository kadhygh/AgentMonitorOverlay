import { expect, test } from "@playwright/test";
import type { Session, Task, TokenStats, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置 → 统计 (2026-10-27): tokens per day / week / month and model, counted when the page opens; 设置 resizes from its
// corner and keeps the size.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("设置 → 统计 counts the turns' tokens by model, as a line, an area or bars, and 设置 can be resized", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  // Two models, one turn each.
  for (const profileId of ["codex-mock", "claude-mock"]) {
    await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: profileId, workspaceId: ws.id, firstSession: { profileId, text: `hello ${profileId}` } });
  }
  await expect.poll(async () => (await studio!.api<TokenStats>("GET", "/api/stats/tokens")).models.map((m) => m.profileId).sort(), { timeout: 60_000 }).toEqual(["claude-mock", "codex-mock"]);
  const counted = await studio.api<TokenStats>("GET", "/api/stats/tokens");
  expect(counted.days.every((d) => d.input + d.cached + d.output > 0 && d.turns >= 1)).toBe(true);

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "统计" }).click();
  await expect(dialog.getByTestId("stats-counted")).toContainText("打开时已重新统计");
  await expect(dialog.getByTestId("stats-tile")).toHaveCount(4);
  await expect(dialog.getByTestId("stats-tile").first()).toContainText("今天");
  await expect(dialog.getByTestId("stats-model")).toHaveCount(2);
  await expect(dialog.getByTestId("stats-mini")).toHaveCount(2);
  await expect(dialog.getByTestId("stats-detail").locator("tbody tr")).toHaveCount(3); // two models + 合计

  // Hovering today shows each model and the total.
  const chart = dialog.getByTestId("stats-chart");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 70, box.y + box.height / 2);
  await expect(dialog.getByTestId("stats-tip")).toContainText("（进行中）");
  await expect(dialog.getByTestId("stats-tip")).toContainText("合计");
  await screenshot(app, "settings", "settings-stats", page);

  // A model can be hidden (at least one stays); the other styles and the table draw too.
  await dialog.getByTestId("stats-model").first().click();
  await expect(dialog.getByTestId("stats-mini")).toHaveCount(1);
  await dialog.getByTestId("stats-model").nth(1).click();
  await expect(dialog.getByTestId("stats-mini")).toHaveCount(1);
  await dialog.getByRole("button", { name: "全部显示" }).click();
  await dialog.getByRole("group", { name: "样式" }).getByRole("button", { name: "柱状" }).click();
  await expect(chart).toBeVisible();
  await dialog.getByRole("group", { name: "粒度" }).getByRole("button", { name: "总计" }).click();
  await expect(dialog.getByTestId("stats-chart")).toContainText("%");
  await dialog.getByRole("group", { name: "图或表" }).getByRole("button", { name: "表" }).click();
  await expect(dialog.locator(".stats-table").first()).toContainText("合计");

  // The corner resizes 设置; the size is kept for the next time; a double click restores the default.
  const before = (await dialog.boundingBox())!;
  const grip = (await dialog.getByTestId("settings-grip").boundingBox())!;
  await page.mouse.move(grip.x + 7, grip.y + 7);
  await page.mouse.down();
  await page.mouse.move(grip.x + 7 + 60, grip.y + 7 + 50, { steps: 5 });
  await page.mouse.up();
  const after = (await dialog.boundingBox())!;
  expect(Math.round(after.width - before.width)).toBe(120);
  expect(Math.round(after.height - before.height)).toBe(50);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置" }).click();
  expect(Math.round((await dialog.boundingBox())!.width)).toBe(Math.round(after.width));
  await dialog.getByTestId("settings-grip").dblclick();
  expect(Math.round((await dialog.boundingBox())!.width)).toBe(Math.round(before.width));
});
