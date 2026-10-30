import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@amo-studio/protocol": src("protocol"),
      "@amo-studio/testkit": src("testkit"),
      "@amo-studio/account": src("account"),
      "@amo-studio/locate": src("locate"),
      "@amo-studio/traymenu": src("traymenu"),
      "@amo-studio/host": src("host"),
      "@amo-studio/reviewer": src("reviewer"),
      // Before the package itself: an alias matches as a prefix.
      "@amo-studio/relay/light": fileURLToPath(new URL("./packages/relay/src/light.ts", import.meta.url)),
      "@amo-studio/relay": src("relay"),
    },
  },
  test: {
    // scripts/: the release scripts' testable parts (platform-publish.mjs).
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
