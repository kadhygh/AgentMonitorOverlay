import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const overlayRoot = fileURLToPath(new URL("../..", import.meta.url));
const utilityWindows = readFileSync(
  `${overlayRoot}/src/hooks/useMainUtilityWindows.ts`,
  "utf8",
);
const harnessLab = readFileSync(
  `${overlayRoot}/src/windows/HarnessLabApp.tsx`,
  "utf8",
);
const priorityManager = readFileSync(
  `${overlayRoot}/src/windows/PriorityManagerApp.tsx`,
  "utf8",
);
const attentionVisuals = readFileSync(
  `${overlayRoot}/src/hooks/useAttentionVisuals.ts`,
  "utf8",
);
const entryHtml = readFileSync(`${overlayRoot}/index.html`, "utf8");

test("the HTML entry renders a loading shell before React is available", () => {
  const rootStart = entryHtml.indexOf('<div id="root">');
  const bootStart = entryHtml.indexOf('class="amo-html-boot"');
  const moduleStart = entryHtml.indexOf('type="module"');

  assert.ok(rootStart >= 0, "the React root should be present");
  assert.ok(bootStart > rootStart, "the root should contain the static loading shell");
  assert.ok(moduleStart > bootStart, "the loading shell should precede the application module");
});

test("utility window creation shows the native shell immediately", () => {
  assert.match(utilityWindows, /visible:\s*label\s*!==\s*"scratchpad"/);
  assert.match(utilityWindows, /transparent:\s*!isHarnessLab/);
  assert.match(utilityWindows, /backgroundColor:\s*isHarnessLab/);
});

test("opening shows and focuses the requested window before cleaning up peers", () => {
  const start = utilityWindows.indexOf("async function openUtilityWindow");
  const end = utilityWindows.indexOf("async function hideUtilityWindow", start);
  const openFlow = utilityWindows.slice(start, end);
  const showIndex = openFlow.indexOf("await target.show()");
  const activeIndex = openFlow.indexOf("setActiveUtilityWindow(label)");
  const coordinationIndex = openFlow.indexOf("void bringUtilityWindowToFront(label)");

  assert.ok(showIndex >= 0, "the target should be shown explicitly");
  assert.ok(activeIndex > showIndex, "the main window should only be blocked after show starts");
  assert.ok(coordinationIndex > showIndex, "window coordination should follow target visibility");
  assert.doesNotMatch(openFlow, /await bringUtilityWindowToFront/);
  assert.doesNotMatch(openFlow, /await otherWindow\.hide/);
});

test("concurrent open and focus requests share one window creation", () => {
  assert.match(utilityWindows, /pendingUtilityWindowRequests\.get\(label\)/);
  assert.match(utilityWindows, /pendingUtilityWindowRequests\.set\(label, request\)/);
});

test("utility window state is event and focus driven instead of continuously polled", () => {
  assert.doesNotMatch(utilityWindows, /setInterval\(sync, 1200\)/);
  assert.match(utilityWindows, /amo-utility-window-state/);
  assert.match(utilityWindows, /addEventListener\("focus", sync\)/);
});

test("Harness status probing starts after the loading shell can paint", () => {
  const frameIndex = harnessLab.indexOf("window.requestAnimationFrame");
  const initialRefreshIndex = harnessLab.indexOf('pollController.start("startup")');

  assert.ok(frameIndex >= 0, "initial loading should wait for a browser frame");
  assert.ok(initialRefreshIndex > frameIndex, "status probing must follow the first-frame gate");
});

test("Harness status polling is adaptive and stops while the window is inactive", () => {
  assert.doesNotMatch(harnessLab, /setInterval/);
  assert.match(harnessLab, /new AdaptivePollController/);
  assert.match(harnessLab, /pollController\.setActive\(event\.payload/);
  assert.match(harnessLab, /return 3_000/);
  assert.match(harnessLab, /return 15_000/);
});

test("secondary session views and attention visuals avoid steady fixed intervals", () => {
  assert.doesNotMatch(priorityManager, /setInterval/);
  assert.match(priorityManager, /new SessionRuntimeController/);
  assert.doesNotMatch(attentionVisuals, /setInterval/);
  assert.match(attentionVisuals, /sessionAttentionVisualNextTransitionAt/);
});
