import { expect, test } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 项目分组 (2026-10-22, design B 树形): right-click a project → 加入分组 (a group or 新建分组…), 移出分组; a group folds,
// takes projects dragged onto it, and is renamed, described or dissolved from its own right-click menu.

let studio: Studio | undefined;
test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("projects go into groups from their menu or by dragging; groups fold, are edited and dissolved, and stay after a reload", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  for (const name of ["alpha", "beta", "gamma"]) await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) });
  const nav = page.getByRole("navigation", { name: "范围", exact: true });
  const projects = nav.getByRole("region", { name: "项目", exact: true });
  const row = (name: string) => nav.getByTestId(`scope-ws-${name}`);
  const group = (name: string) => projects.getByRole("group", { name, exact: true });
  const members = (name: string) => group(name).locator(".nav-group-body .nav-row .name");
  await expect(row("gamma")).toBeVisible();

  // 新建分组… from a project's menu: the group is made with that project in it.
  await row("alpha").click({ button: "right" });
  await page.getByTestId("join-group-item").click();
  await page.getByTestId("new-group-item").click();
  await page.getByTestId("edit-group-name").fill("客户端");
  await page.getByTestId("edit-group-description").fill("Unity 客户端和资源仓库");
  await page.getByTestId("edit-group-save").click();
  await expect(members("客户端")).toHaveText(["alpha"]);

  // An existing group from the menu; another project dragged onto the heading.
  await row("beta").click({ button: "right" });
  await page.getByTestId("join-group-item").click();
  await page.getByTestId("join-group").filter({ hasText: "客户端" }).click();
  await expect(members("客户端")).toHaveText(["alpha", "beta"]);
  await row("gamma").dragTo(nav.getByTestId("group-客户端"));
  await expect(members("客户端")).toHaveCount(3);
  await expect(nav.getByTestId("group-客户端").locator(".count")).toHaveText("3");

  // 移出分组: back below the groups.
  await row("gamma").click({ button: "right" });
  await page.getByTestId("join-group-item").click();
  await expect(page.getByTestId("join-group").filter({ hasText: "客户端" })).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("leave-group-item").click();
  await expect(members("客户端")).toHaveText(["alpha", "beta"]);
  await expect(row("gamma")).toBeVisible();

  // Folding hides its projects; the heading keeps the count.
  await nav.getByTestId("group-客户端").click();
  await expect(nav.getByTestId("group-客户端")).toHaveAttribute("aria-expanded", "false");
  await expect(row("alpha")).toHaveCount(0);
  await expect(nav.getByTestId("group-客户端").locator(".count")).toHaveText("2");
  await nav.getByTestId("group-客户端").click();
  await expect(row("alpha")).toBeVisible();

  // 编辑分组: a new name and note (the note shows when hovering the heading).
  await nav.getByTestId("group-客户端").click({ button: "right" });
  await page.getByTestId("edit-group-item").click();
  await expect(page.getByTestId("edit-group-name")).toHaveValue("客户端");
  await page.getByTestId("edit-group-name").fill("前端");
  await page.getByTestId("edit-group-description").fill("客户端和 UI 原型");
  await page.getByTestId("edit-group-save").click();
  await expect(nav.getByTestId("group-前端")).toHaveAttribute("title", /客户端和 UI 原型/);

  // Kept by the Host: still there after a reload.
  await page.reload();
  await expect(members("前端")).toHaveText(["alpha", "beta"]);
  await screenshot(app, "stage-18", "S18-project-groups", page);

  // 解散分组: the projects stay, out of any group.
  await nav.getByTestId("group-前端").click({ button: "right" });
  await page.getByTestId("dissolve-group").click();
  await expect(nav.getByTestId("group-前端")).toHaveCount(0);
  await expect(projects.locator(".nav-row .name")).toHaveCount(3);
});
