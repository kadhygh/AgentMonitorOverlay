import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { hmr: { port: 24680 }, middlewareMode: true },
});
const {
  confirmedObsidianOpen,
  shouldMarkReviewedForObsidianOpen,
  supportsConfirmedObsidianOpen,
} = await vite.ssrLoadModule("/src/runtime/obsidianOpenPolicy.ts");

after(async () => {
  await vite.close();
});

const capableRuntime = { active: true, capabilities: ["open-result-v1"] };

test("only an active capable plugin enables confirmed-open semantics", () => {
  assert.equal(supportsConfirmedObsidianOpen(capableRuntime), true);
  assert.equal(supportsConfirmedObsidianOpen({ active: false, capabilities: ["open-result-v1"] }), false);
  assert.equal(supportsConfirmedObsidianOpen({ active: true, capabilities: [] }), false);
});

test("opened and focused acknowledgments are successful", () => {
  assert.equal(confirmedObsidianOpen({ ok: true, status: "opened" }), true);
  assert.equal(confirmedObsidianOpen({ ok: true, status: "focused" }), true);
  assert.equal(confirmedObsidianOpen({ ok: false, status: "not_found" }), false);
  assert.equal(confirmedObsidianOpen(null), false);
});

test("review mutation requires both capability and a successful acknowledgment", () => {
  assert.equal(shouldMarkReviewedForObsidianOpen(capableRuntime, { ok: true, status: "opened" }), true);
  assert.equal(shouldMarkReviewedForObsidianOpen(capableRuntime, { ok: false, status: "error" }), false);
  assert.equal(shouldMarkReviewedForObsidianOpen(null, { ok: true, status: "opened" }), false);
});
