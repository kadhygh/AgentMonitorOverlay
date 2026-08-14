import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const overlayRoot = fileURLToPath(new URL("../..", import.meta.url));
const mainEntry = readFileSync(`${overlayRoot}/src/main.tsx`, "utf8");
const mainOverlay = readFileSync(`${overlayRoot}/src/windows/MainOverlayApp.tsx`, "utf8");
const shellLifecycle = readFileSync(`${overlayRoot}/src/hooks/useMainShellLifecycle.ts`, "utf8");
const brokerSessions = readFileSync(`${overlayRoot}/src/hooks/useBrokerSessions.ts`, "utf8");

test("the main entry renders without owning Broker startup", () => {
  assert.doesNotMatch(mainEntry, /ensureBrokerStarted/);
  assert.match(mainEntry, /void installStartupStatusReplay/);
  assert.match(mainEntry, /await renderApplication\(\)/);
});

test("native startup handoff follows the React DOM commit without waiting on hidden-window RAF", () => {
  const frameIndex = shellLifecycle.indexOf("window.requestAnimationFrame");
  const completionIndex = shellLifecycle.indexOf('invoke("complete_startup")');
  const readyIndex = shellLifecycle.indexOf('invoke("signal_frontend_ready")');
  assert.ok(completionIndex >= 0, "the committed shell should request native handoff");
  assert.ok(frameIndex >= 0, "the shell lifecycle should wait for a browser frame");
  assert.ok(completionIndex < frameIndex, "native handoff must not depend on hidden-window RAF");
  assert.ok(readyIndex > frameIndex, "the visible-frame smoke marker should follow the paint gate");
});

test("MainOverlayApp no longer gates its frame on the initial session snapshot", () => {
  assert.match(mainOverlay, /useMainShellLifecycle\(\)/);
  assert.doesNotMatch(mainOverlay, /invoke\("complete_startup"\)/);
  assert.doesNotMatch(mainOverlay, /<main className="amo-boot"/);
  assert.match(mainOverlay, /!sessionDataReady \? \(/);
});

test("initial snapshot failure is represented independently from SSE health", () => {
  assert.match(brokerSessions, /SessionHydration/);
  assert.match(brokerSessions, /setSessionHydration\(\{ state: "error", message \}\)/);
  assert.match(brokerSessions, /initial-stale-retry/);
});
