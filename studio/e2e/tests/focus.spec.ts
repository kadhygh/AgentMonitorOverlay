import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const focusIgnore = (s: Studio) => s.app.evaluate(() => (globalThis as { __amoFocusIgnore?: boolean }).__amoFocusIgnore);

test("Focus lists what needs me, approves in place and opens the workbench", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "掉落表校验",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo focus-approved]]" },
  });

  // Tests start with Focus off; turn it on from the top bar.
  const toggle = page.getByRole("button", { name: /^Focus/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const opened = app.waitForEvent("window");
  await toggle.click();
  const focus = await opened;
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Red line 7 and the window's nature: off-screen, never focused, not focusable, on top.
  await expect.poll(() => windowState(app, "focus")).toMatchObject({ visible: true, onScreen: false, anyFocused: false, focusable: false, alwaysOnTop: true });

  // The pending approval shows up, opened, with the command.
  await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1", { timeout: 30_000 });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("掉落表校验");
  await expect(entry).toContainText("待批准");
  await expect(focus.getByTestId("focus-snippet")).toContainText("cmd /c echo focus-approved");

  // Clicks pass through the window except over the panel.
  await focus.getByTestId("focus-panel").hover();
  await expect.poll(() => focusIgnore(studio!)).toBe(false);
  await focus.mouse.move(5, 5);
  await expect.poll(() => focusIgnore(studio!)).toBe(true);
  await screenshot(app, "stage-3", "S3-07-focus", focus, "focus");

  // "在工作台打开" shows that session in the workbench.
  await focus.getByRole("button", { name: "在工作台打开" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("掉落表校验");
  await expect(page.getByTestId("approval").first()).toHaveAttribute("data-state", "pending");

  // Approve in place.
  await focus.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByTestId("approval").first()).toHaveAttribute("data-state", "accepted");
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  await expect(focus.getByTestId("focus-entry")).toHaveCount(0);
  await expect
    .poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status, { timeout: 30_000 })
    .not.toBe("awaiting-approval");

  // Turning it off closes the window.
  const closed = focus.waitForEvent("close");
  await toggle.click();
  await closed;
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect((await windowState(app)).anyFocused).toBe(false);
});
