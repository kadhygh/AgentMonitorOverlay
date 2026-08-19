const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { renameCodexThreadName } = require("./codex-app-server");

test("Codex app-server adapter initializes and sends thread/name/set", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-codex-app-server-"));
  const fixture = path.join(root, "fake-app-server.cjs");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(fixture, [
    "process.stdin.setEncoding('utf8');",
    "let buffer = '';",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  const lines = buffer.split(/\\r?\\n/u);",
    "  buffer = lines.pop() || '';",
    "  for (const line of lines) {",
    "    if (!line.trim()) continue;",
    "    const message = JSON.parse(line);",
    "    if (message.id === 1 && message.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    "    if (message.id === 2) {",
    "      const expected = { threadId: process.argv[2], name: process.argv[3] };",
    "      if (message.method !== 'thread/name/set' || JSON.stringify(message.params) !== JSON.stringify(expected)) {",
    "        process.stdout.write(JSON.stringify({ id: 2, error: { message: 'unexpected rename request' } }) + '\\n');",
    "      } else {",
    "        process.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\\n');",
    "      }",
    "    }",
    "  }",
    "});",
  ].join("\n"), "utf8");

  const result = await renameCodexThreadName("thread-123", "dev1-开发模块", {
    command: { executable: process.execPath, argsPrefix: [fixture, "thread-123", "dev1-开发模块"], shell: false },
    timeoutMs: 2_000,
  });

  assert.deepEqual(result, { ok: true, threadId: "thread-123", name: "dev1-开发模块" });
});
