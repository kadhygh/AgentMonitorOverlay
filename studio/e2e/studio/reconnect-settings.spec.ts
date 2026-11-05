import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StudioSettings } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-11-04 (plans/done/cleanup-2026-11.md 第 7 步): what the window reads from the Host is read again after the event
// socket comes back (host/live.ts, host/shared.ts). The Host dies and the shell starts it again; changes made before
// the window has reconnected (no event reaches it) show in 设置 once it has: a preset (the settings, one copy per
// window) and a 值守 item (the shell's copy).

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("设置 follows what changed while the Host was away", async () => {
  studio = await launchStudio({ env: { AMO_STUDIO_KEEPALIVE_MS: "400" } });
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "模型" }).click();
  await dialog.getByTestId("models-nav-presets").click();
  await expect(dialog.getByTestId("preset-row")).toHaveCount(0);

  const before = (JSON.parse(readFileSync(join(studio.dataDir, "host.json"), "utf8")) as { pid: number }).pid;
  process.kill(before);
  // The window waits 2 s before reconnecting; the Host is back sooner (keep-alive 400 ms), so these land unseen.
  await expect
    .poll(
      async () => {
        const pid = (JSON.parse(readFileSync(join(studio!.dataDir, "host.json"), "utf8")) as { pid: number }).pid;
        if (pid === before) return false;
        return studio!.api("GET", "/api/settings").then(
          () => true,
          () => false,
        );
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBe(true);
  const settings = await studio.api<StudioSettings>("GET", "/api/settings");
  await studio.api("PUT", "/api/settings", { presets: [...settings.presets, { id: "p-away", name: "断线时加的预设", profileId: "codex-mock", options: {} }] });
  await studio.api("POST", "/api/duty/items", { title: "断线时加的值守", enabled: false, schedule: { every: 600 }, action: { kind: "command", command: "echo hi" } });

  await expect(page.getByTestId("host-error")).toContainText("Host 意外退出，已自动重新启动", { timeout: 30_000 });
  await expect(dialog.getByTestId("preset-row")).toContainText("断线时加的预设", { timeout: 15_000 });
  await dialog.getByRole("tab", { name: "值守" }).click();
  await expect(dialog.getByTestId("duty-item").filter({ hasText: "断线时加的值守" })).toBeVisible({ timeout: 15_000 });
  await screenshot(app, "studio", "reconnect-settings", page);
});
