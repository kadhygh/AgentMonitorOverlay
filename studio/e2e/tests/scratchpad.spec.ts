import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "./studio.js";

let studio: Studio | undefined;
let root: string | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
  if (root) removeTempDir(root);
  root = undefined;
});

test("the global scratchpad saves while typing and survives an app restart", async () => {
  // Mock model and sandbox CODEX_HOME: even an idle session must never touch the user's real Codex home.
  studio = await launchStudio();
  root = studio.root;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "草稿",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-mock" },
  });
  await studio.page.getByTestId("task-card").first().click();

  const pad = studio.page.getByRole("textbox", { name: "草稿" });
  await pad.fill("明天：\n- 和策划对掉落表");
  await expect(studio.page.getByTestId("scratchpad-status")).toHaveText("已保存");
  await screenshot(studio.app, "stage-2", "S2-05-scratchpad", studio.page);

  // Leaving right after typing still saves the last edit (flushed on unmount).
  await pad.fill("明天：\n- 和策划对掉落表\n- 发版");
  await studio.page.getByRole("button", { name: "← 看板" }).click();
  await expect.poll(async () => (await studio!.api<{ text: string }>("GET", "/api/scratchpad")).text).toBe("明天：\n- 和策划对掉落表\n- 发版");
  await studio.page.getByTestId("task-card").first().click();
  await pad.fill("明天：\n- 和策划对掉落表");
  await expect(studio.page.getByTestId("scratchpad-status")).toHaveText("已保存");

  await studio.close({ keepData: true });
  expect(existsSync(join(root, "data", "host.lock"))).toBe(false);
  studio = await launchStudio({ root });
  await studio.page.getByTestId("task-card").first().click();
  await expect(studio.page.getByRole("textbox", { name: "草稿" })).toHaveValue("明天：\n- 和策划对掉落表");
});
