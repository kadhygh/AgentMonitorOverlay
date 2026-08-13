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
  obsidianOpenAttemptRequestId,
  retryableObsidianOpenResult,
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

test("Obsidian retries use a new protocol request id", () => {
  assert.equal(obsidianOpenAttemptRequestId("amo-open-123", 1), "amo-open-123");
  assert.equal(obsidianOpenAttemptRequestId("amo-open-123", 2), "amo-open-123-attempt-2");
  assert.notEqual(
    obsidianOpenAttemptRequestId("amo-open-123", 1),
    obsidianOpenAttemptRequestId("amo-open-123", 2),
  );
});

test("only a foreign-vault rejection is retryable", () => {
  assert.equal(
    retryableObsidianOpenResult({
      ok: false,
      openRequestId: "amo-open-123",
      status: "rejected",
      message: "AMO open request targets a different vault.",
    }),
    true,
  );
  assert.equal(
    retryableObsidianOpenResult({
      ok: false,
      openRequestId: "amo-open-123",
      status: "rejected",
      message: "AMO open URL is missing a vault-relative path.",
    }),
    false,
  );
  assert.equal(
    retryableObsidianOpenResult({
      ok: false,
      openRequestId: "amo-open-123",
      status: "not_found",
      message: "Target note was not found.",
    }),
    false,
  );
});
