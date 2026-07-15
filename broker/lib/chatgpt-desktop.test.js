const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chatGptWorkspaceUri,
  prepareChatGptWorkspaceLaunch,
} = require("./chatgpt-desktop");

test("ChatGPT workspace URI uses the compatible codex scheme and an encoded absolute path", () => {
  assert.equal(
    chatGptWorkspaceUri("G:\\PROJECT\\Project with spaces"),
    "codex://threads/new?path=G%3A%5CPROJECT%5CProject%20with%20spaces",
  );
});

test("workspace launch delegates the canonical deep link to the native client", () => {
  assert.deepEqual(prepareChatGptWorkspaceLaunch("G:\\PROJECT\\AMO"), {
    pid: null,
    command: "open_uri",
    args: ["codex://threads/new?path=G%3A%5CPROJECT%5CAMO"],
    uri: "codex://threads/new?path=G%3A%5CPROJECT%5CAMO",
  });
});
