import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const overlayRoot = fileURLToPath(new URL("../..", import.meta.url));
const utilityWindowSource = readFileSync(
  `${overlayRoot}/src/windows/utilityWindow.ts`,
  "utf8",
);
const capability = JSON.parse(
  readFileSync(`${overlayRoot}/src-tauri/capabilities/default.json`, "utf8"),
);

test("every utility window receives the default Tauri window capability", () => {
  const declaration = utilityWindowSource.match(
    /export type UtilityWindowKind\s*=\s*([^;]+);/,
  );
  assert.ok(declaration, "UtilityWindowKind declaration should remain discoverable");

  const labels = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(labels.length > 0, "at least one utility window label should be declared");

  for (const label of labels) {
    assert.ok(
      capability.windows.includes(label),
      `utility window "${label}" must be listed in capabilities/default.json`,
    );
  }
});
