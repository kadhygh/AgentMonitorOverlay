import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { programLaunch } from "../support/packed.js";
import { screenshot, studioRoot } from "../support/studio.js";
import { exerciseImageView, png } from "../support/images.js";

// 图片缩放、拖拽 + 右键另存为 in the AMO Reviewer on its own (2026-11-11, the user: 常规的 Reviewer 也要支持): a picture opened
// with amo-review --reviewer is fitted whole, zooms, drags, and saves through 另存为… (the save dialog answered here).

const MAIN = join(studioRoot, "packages", "reviewer", "dist", "main.js");
const CLI = join(studioRoot, "scripts", "amo-review.mjs");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC_|AMO_)/.test(k)) env[k] = v;
  return { ...env, AMO_REVIEWER_TEST: "1", AMO_REVIEWER_HOME: home };
}

let app: ElectronApplication | undefined;
let root = "";

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) removeTempDir(root);
});

async function windowAt(a: ElectronApplication, part: string): Promise<Page> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const w = a.windows().find((p) => p.url().includes(part));
    if (w) {
      await w.waitForLoadState("domcontentloaded");
      return w;
    }
    if (Date.now() > deadline) throw new Error(`no window at ${part}`);
    await a.waitForEvent("window", { timeout: 2000 }).catch(() => undefined);
  }
}

test("a picture in the Reviewer's viewer opens fitted whole, zooms, drags, and saves through 另存为…", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-reviewer-image-"));
  const home = join(root, "home");
  const repo = join(root, "game");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  const shot = png(1800, 1100, [90, 170, 120]);
  writeFileSync(join(repo, "shot.png"), shot);
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.1\nreturn rate\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "drop.lua"), "local rate = 0.25\nreturn rate\n");

  const launched = programLaunch("reviewer", MAIN);
  app = await _electron.launch({ executablePath: launched.executablePath, args: [...launched.args, repo], env: cleanEnv(home) });
  await windowAt(app, "reviewer.html#review");
  await promisify(execFile)(process.execPath, [CLI, repo, "--reviewer", "--mode", "file", "--file", "shot.png"], { env: cleanEnv(home), encoding: "utf8", windowsHide: true });
  const viewer = await windowAt(app, "reviewer.html#viewer");
  await expect(viewer.getByTestId("viewer-name")).toHaveText("shot.png");
  mkdirSync(join(root, "saved"), { recursive: true });
  await exerciseImageView(app, viewer, { imgTestId: "file-preview-image", saveTo: join(root, "saved", "shot.png"), bytes: shot, width: 1800, height: 1100 });
  await viewer.getByTestId("file-preview-image").click({ button: "right" });
  await expect(viewer.getByTestId("image-view-menu")).toBeVisible();
  await screenshot(app, "reviewer", "viewer-image-menu", viewer, "viewer");
});
