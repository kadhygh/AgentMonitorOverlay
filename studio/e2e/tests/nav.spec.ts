import { expect, test } from "@playwright/test";
import type { Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// The left column: pinned topics and projects come first and stay when a section is folded; long lists scroll between
// the fixed top and the footer; the footer opens the subscription usage.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("pin, fold and scroll the left column; open the usage footer", async () => {
  studio = await launchStudio();
  const { page } = studio;
  for (const name of ["alpha", "beta"]) await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) });
  for (let i = 1; i <= 24; i++) await studio.api<Topic>("POST", "/api/topics", { title: `专题 ${String(i).padStart(2, "0")}` });
  await expect(page.locator('[data-testid^="scope-topic-"]')).toHaveCount(24);

  // Long lists scroll inside the middle area; the footer stays put.
  const scroller = page.locator(".nav-scroll");
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.getByTestId("host-status")).toBeInViewport();

  // Pin the last topic: it moves to the top.
  const last = page.locator(".nav-item").filter({ has: page.getByTestId("scope-topic-专题 24") });
  await last.hover();
  await last.getByTestId("pin").click();
  await expect(page.locator('[data-testid^="scope-topic-"]').first()).toHaveText(/专题 24/);

  // Fold topics: only the pinned one stays, with a way back to the rest.
  await page.getByTestId("fold-topic").click();
  await expect(page.locator('[data-testid^="scope-topic-"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "还有 23 个专题" })).toBeVisible();
  await screenshot(studio.app, "stage-10", "S10-nav-pins", page);

  // The pin carries over to # in the new-task page: pinned first.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("第一句话").pressSequentially("#专题");
  await expect(page.getByTestId("suggest").getByRole("option").first()).toContainText("专题 24");
  await page.getByRole("button", { name: "← 看板" }).click();

  // Usage: the test Claude subscription runs on a token, which cannot read the account's quota; the panel says so
  // instead of showing numbers it does not have.
  await page.getByTestId("host-status").click();
  await expect(page.getByTestId("usage-account")).toContainText("查不到用量百分比");
});
