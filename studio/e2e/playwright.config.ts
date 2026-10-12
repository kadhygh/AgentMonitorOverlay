import { defineConfig } from "@playwright/test";

// Electron end-to-end tests. Windows stay hidden and never take focus; screenshots use webContents.capturePage.
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results",
});
