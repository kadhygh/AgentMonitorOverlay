import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 外部打开 Review (2026-10-18): another tool runs amo-review (scripts/amo-review.mjs) while Studio is open; the main
// window opens the review window on the project, with a base or a range, and 发回 aimed at the given session.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "amo-review.mjs");
const amoReview = (dataDir: string, ...args: string[]) => promisify(execFile)(process.execPath, [SCRIPT, ...args, "--data", dataDir], { encoding: "utf8", windowsHide: true });

async function nextWindow(app: ElectronApplication, act: () => Promise<unknown>): Promise<Page> {
  const opened = app.waitForEvent("window");
  await act();
  const win = await opened;
  await win.waitForLoadState("domcontentloaded");
  return win;
}

test("another tool opens Review on a folder: the working tree against a base, and a range", async () => {
  studio = await launchStudio();
  const { app, dataDir } = studio;
  const dir = studio.workspace("agent-work");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "return 0.1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "agent");
  writeFileSync(join(dir, "boss.lua"), "return 'Lv20'\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "agent: boss");
  writeFileSync(join(dir, "drop.lua"), "return 0.25\n");

  // A session to send the comments to, in another project.
  const other = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("other") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "审阅 agent 的改动", workspaceId: other.id, firstSession: { profileId: "codex-mock", text: "hello" } });

  // The working tree against main: comments allowed, 发回 aimed at that session; the folder becomes a project.
  let out = "";
  const review = await nextWindow(app, async () => (out = (await amoReview(dataDir, dir, "--base", "main", "--session", session.id, "--file", "drop.lua")).stdout));
  expect(out).toContain("工作区对比 main");
  expect(out).toContain("新登记了这个项目");
  await expect(review.getByTestId("review-branch")).toContainText("对比 main");
  await expect(review.getByTestId("review-file")).toHaveCount(2);
  await expect(review.getByTestId("review-file").filter({ hasText: "drop.lua" })).toHaveAttribute("aria-current", /true|page/);
  await expect(review.getByTestId("review-session")).toHaveValue(session.id);
  await screenshot(app, "stage-18", "S18-review-open-base", review, "review");

  // A range: read-only, against the first ref.
  const ranged = await nextWindow(app, () => amoReview(dataDir, dir, "--range", "main..agent"));
  await expect(ranged.getByTestId("review-file")).toHaveText([/boss\.lua/]);
  await expect(ranged.getByTestId("review-commit-footer")).toContainText(`对比 ${git(dir, "rev-parse", "--short=7", "main")}`);

  // A ref that is not there: refused, exit 1, nothing opened.
  const bad = await amoReview(dataDir, dir, "--commit", "nope").catch((e: { code: number; stderr: string }) => e);
  expect(bad).toMatchObject({ code: 1 });
  expect((bad as { stderr: string }).stderr).toContain("没有打开");
});

test("amo-review says when AMO Studio is not running", async () => {
  const r = await promisify(execFile)(process.execPath, [SCRIPT, ".", "--data", join(HERE, "no-such-data")], { encoding: "utf8", windowsHide: true }).catch((e: { code: number; stderr: string }) => e);
  expect(r).toMatchObject({ code: 2 });
  expect((r as { stderr: string }).stderr).toContain("没有在运行");
});
