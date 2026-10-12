import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("renders tables, nested lists, code with copy, and opens links outside the app", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "渲染检查",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await page.getByTestId("task-card").first().click();

  const reply = page.getByTestId("msg-agent").last();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });
  await expect(reply.locator("table.md-table th")).toHaveText(["表", "概率和"]);
  await expect(reply.locator("table.md-table tbody tr")).toHaveCount(2);
  await expect(reply.locator("ol.md-list > li")).toHaveCount(2);
  await expect(reply.locator("ol.md-list > li").first().locator("ul.md-list > li")).toHaveCount(2);
  await expect(reply.locator(".md-code-head")).toContainText("csharp");
  await expect(reply.locator(".md-pre")).toHaveText("DropTable.Normalize(table);");

  // Every rendered block carries its range in the reply's markdown source.
  const ranges = await reply.locator("[data-src-start]").evaluateAll((els) => els.map((e) => [Number(e.getAttribute("data-src-start")), Number(e.getAttribute("data-src-end"))]));
  expect(ranges.length).toBeGreaterThanOrEqual(5);
  for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBeGreaterThan(ranges[i - 1]![1]!);

  await reply.getByRole("button", { name: "复制" }).click();
  await expect(reply.getByRole("button", { name: "已复制" })).toBeVisible();
  expect(await app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied)).toEqual(["DropTable.Normalize(table);"]);

  // Test mode records the URL instead of opening the system browser.
  await reply.getByRole("link", { name: "掉落表规范" }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { __amoOpenedUrls?: string[] }).__amoOpenedUrls ?? [])).toEqual(["https://example.com/drop-tables"]);
  await screenshot(app, "stage-2", "S2-01-markdown", page);
});
