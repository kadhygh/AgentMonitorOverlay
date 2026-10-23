import { expect, test } from "@playwright/test";
import type { Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("sidebar projects, topics and sections reorder by dragging and retain their order after reopening", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const projects: Workspace[] = [];
  const topics: Topic[] = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    projects.push(await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) }));
    topics.push(await studio.api<Topic>("POST", "/api/topics", { title: `${name} topic` }));
  }
  const nav = page.getByRole("navigation", { name: "范围", exact: true });
  const projectsSection = nav.getByRole("region", { name: "项目", exact: true });
  const topicsSection = nav.getByRole("region", { name: "专题", exact: true });
  const projectNames = projectsSection.locator(".nav-row .name");
  const topicNames = topicsSection.locator(".nav-row .name");
  await expect(projectNames).toHaveCount(3);
  await expect(topicNames).toHaveCount(3);
  const initialProjects = await projectNames.allTextContents();
  const initialTopics = await topicNames.allTextContents();
  const projectRow = (name: string) => nav.getByTestId(`scope-ws-${name}`);
  const topicRow = (name: string) => nav.getByTestId(`scope-topic-${name}`);

  // Last before first; another move after last. Dragging does not navigate away from 全部任务.
  await projectRow(initialProjects[2]!).dragTo(projectRow(initialProjects[0]!), { targetPosition: { x: 30, y: 4 } });
  await expect(projectNames).toHaveText([initialProjects[2]!, initialProjects[0]!, initialProjects[1]!]);
  await projectRow(initialProjects[2]!).dragTo(projectRow(initialProjects[1]!), { targetPosition: { x: 30, y: 28 } });
  await expect(projectNames).toHaveText(initialProjects);
  await projectRow(initialProjects[1]!).dragTo(projectRow(initialProjects[0]!), { targetPosition: { x: 30, y: 4 } });
  const expectedProjects = [initialProjects[1]!, initialProjects[0]!, initialProjects[2]!];
  await topicRow(initialTopics[2]!).dragTo(topicRow(initialTopics[0]!), { targetPosition: { x: 30, y: 4 } });
  const expectedTopics = [initialTopics[2]!, initialTopics[0]!, initialTopics[1]!];
  await expect(projectNames).toHaveText(expectedProjects);
  await expect(topicNames).toHaveText(expectedTopics);
  await expect(nav.getByTestId("scope-all")).toHaveAttribute("aria-current", "true");

  // A project dropped on a topic is not reassigned and does not alter either order.
  await projectRow(expectedProjects[0]!).dragTo(topicRow(expectedTopics[0]!));
  await expect(projectNames).toHaveText(expectedProjects);
  await expect(topicNames).toHaveText(expectedTopics);

  await projectsSection.locator(".nav-head").dragTo(topicsSection.locator(".nav-head"));
  await expect(nav.locator(".nav-section-box").first()).toHaveAttribute("aria-label", "项目");
  await topicsSection.locator(".nav-head").dragTo(projectsSection.locator(".nav-head"));
  await expect(nav.locator(".nav-section-box").first()).toHaveAttribute("aria-label", "专题");
  await projectsSection.locator(".nav-head").dragTo(topicsSection.locator(".nav-head"));
  await page.reload();
  await expect(projectNames).toHaveText(expectedProjects);
  await expect(topicNames).toHaveText(expectedTopics);
  await expect(nav.locator(".nav-section-box").first()).toHaveAttribute("aria-label", "项目");

  // Saved order names ids, so renaming an entry leaves its place intact; new entries are appended.
  const renamed = projects.find((w) => w.name === expectedProjects[0])!;
  await studio.api("PATCH", `/api/workspaces/${renamed.id}`, { name: "renamed project" });
  expectedProjects[0] = "renamed project";
  await studio.api("POST", "/api/topics", { title: "new topic" });
  await expect(projectNames).toHaveText(expectedProjects);
  await expect(topicNames).toHaveText([...expectedTopics, "new topic"]);
  await screenshot(app, "stage-18", "S18-nav-order", page);

  const root = studio.root;
  // Like other UI preferences, this order belongs to the installation's origin. Restart at its same address.
  const port = new URL(page.url()).port;
  await studio.close({ keepData: true });
  studio = undefined;
  studio = await launchStudio({ root, env: { AMO_STUDIO_PORT: port } });
  const reopened = studio.page.getByRole("navigation", { name: "范围", exact: true });
  await expect(reopened.locator(".nav-section-box").first()).toHaveAttribute("aria-label", "项目");
  await expect(reopened.locator('[data-testid^="scope-ws-"] .name')).toHaveText(expectedProjects);
  await expect(reopened.locator('[data-testid^="scope-topic-"] .name')).toHaveText([...expectedTopics, "new topic"]);
});

test("pinned entries stay first, reorder within their group, and folding preserves hidden entries", async () => {
  studio = await launchStudio();
  const { page } = studio;
  for (const name of ["alpha", "beta", "gamma", "delta"]) await studio.api("POST", "/api/workspaces", { path: studio.workspace(name) });
  const nav = page.getByRole("navigation", { name: "范围", exact: true });
  const rows = nav.locator('[data-testid^="scope-ws-"] .name');
  const row = (name: string) => nav.getByTestId(`scope-ws-${name}`);
  const pin = (name: string) => row(name).locator("..").getByTestId("pin");
  await expect(rows).toHaveCount(4);
  await pin("beta").click();
  await pin("delta").click();
  await expect(rows).toHaveText(["beta", "delta", "alpha", "gamma"]);
  await row("delta").dragTo(row("beta"), { targetPosition: { x: 30, y: 4 } });
  await expect(rows).toHaveText(["delta", "beta", "alpha", "gamma"]);
  await row("gamma").dragTo(row("delta"), { targetPosition: { x: 30, y: 4 } });
  await expect(rows).toHaveText(["delta", "beta", "alpha", "gamma"]);
  await nav.getByTestId("fold-project").click();
  await expect(rows).toHaveText(["delta", "beta"]);
  await row("beta").dragTo(row("delta"), { targetPosition: { x: 30, y: 4 } });
  await nav.getByTestId("fold-project").click();
  await expect(rows).toHaveText(["beta", "delta", "alpha", "gamma"]);
  await row("gamma").focus();
  await row("gamma").press("Alt+ArrowUp");
  await expect(rows).toHaveText(["beta", "delta", "gamma", "alpha"]);
  await page.reload();
  await expect(rows).toHaveText(["beta", "delta", "gamma", "alpha"]);
});
