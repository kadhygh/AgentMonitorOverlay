const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveSessionTitle } = require("./display-names");

test("Grok cards pick up generated_title from the local session summary", () => {
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "amo-grok-titles-"));
  const previousGrokHome = process.env.GROK_HOME;
  const sessionId = "01a03ecb-a7b4-7013-a682-3262542ca4e7";
  const sessionDir = path.join(grokHome, "sessions", "D%3A%5CProjects%5Cproject_mining", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "summary.json"), `${JSON.stringify({
    info: { id: sessionId },
    generated_title: "Greeting and Model Identity Question",
    session_summary: "Greeting and Model Identity Question",
    updated_at: "2026-08-26T16:00:16.851Z",
  }, null, 2)}\n`);

  try {
    process.env.GROK_HOME = grokHome;
    assert.equal(
      resolveSessionTitle("grok", sessionId, null, `grok - ${sessionId}`),
      "Greeting and Model Identity Question",
    );
  } finally {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    fs.rmSync(grokHome, { recursive: true, force: true });
  }
});

test("display-only AMO names win over later Grok generated titles", () => {
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "amo-grok-titles-"));
  const previousGrokHome = process.env.GROK_HOME;
  const sessionId = "grok-named";
  const sessionDir = path.join(grokHome, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "summary.json"), `${JSON.stringify({
    info: { id: sessionId },
    generated_title: "Greeting and Model Identity Question",
  }, null, 2)}\n`);

  try {
    process.env.GROK_HOME = grokHome;
    assert.equal(
      resolveSessionTitle("grok", sessionId, null, "grok - grok-named", {
        status: "display-only",
        requestedName: "main-是什么大模型",
      }),
      "main-是什么大模型",
    );
  } finally {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    fs.rmSync(grokHome, { recursive: true, force: true });
  }
});
