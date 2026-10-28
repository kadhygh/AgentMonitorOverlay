import { defineConfig } from "@playwright/test";

// Electron end-to-end tests of AMO Studio and the programs that come with it (the 便签, the Reviewer). Windows stay hidden and never take focus; screenshots use webContents.capturePage.
export default defineConfig({
  // One folder per program (2026-10-23): `--project notes` runs the 便签's alone; support/ holds the launch helpers.
  projects: [
    { name: "studio", testDir: "./studio" },
    { name: "notes", testDir: "./notes" },
    { name: "reviewer", testDir: "./reviewer" },
    { name: "relay", testDir: "./relay" },
    { name: "platform", testDir: "./platform" },
  ],
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results",
});
