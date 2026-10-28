import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@amo-studio/protocol": src("protocol"),
      "@amo-studio/testkit": src("testkit"),
      "@amo-studio/account": src("account"),
      "@amo-studio/host": src("host"),
      "@amo-studio/reviewer": src("reviewer"),
      "@amo-studio/relay": src("relay"),
    },
  },
  test: {
    // scripts/: the release scripts' testable parts (platform-publish.mjs).
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
