const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 6_000;

function renameCodexThreadName(threadId, name, options = {}) {
  if (!threadId || !name) return Promise.reject(new Error("Codex thread rename requires threadId and name"));

  const command = options.command || resolveCodexCommand();
  const child = (options.spawnProcess || spawn)(
    command.executable,
    [...(command.argsPrefix || []), "app-server", "--listen", "stdio://"],
    {
      windowsHide: true,
      shell: Boolean(command.shell),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let initialized = false;
    const timeout = setTimeout(() => finish(new Error(`Codex thread rename timed out after ${timeoutMs} ms`)), timeoutMs);

    function finish(error, result = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(result);
    }

    function write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) return finish(rpcError("initialize", message.error, stderrBuffer));
        initialized = true;
        write({ method: "initialized", params: {} });
        write({ id: 2, method: "thread/name/set", params: { threadId, name } });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) return finish(rpcError("thread/name/set", message.error, stderrBuffer));
      finish(null, { ok: true, threadId, name });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // App-server may emit non-protocol diagnostics; stderr is included on failure.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2_000);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const phase = initialized ? "before thread/name/set completed" : "before initialization";
        finish(new Error(`Codex app-server exited ${phase} (code ${code ?? "none"}, signal ${signal ?? "none"})${formatStderr(stderrBuffer)}`));
      }
    });

    write({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent_monitor_overlay", title: "Agent Monitor Overlay", version: "0.1.7" },
      },
    });
  });
}

function resolveCodexCommand() {
  const configured = `${process.env.AMO_CODEX_EXECUTABLE || ""}`.trim();
  if (configured) return { executable: configured, argsPrefix: [], shell: process.platform === "win32" && /\.(cmd|bat)$/iu.test(configured) };

  if (process.platform === "win32" && process.env.APPDATA) {
    const cliScript = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(cliScript)) return { executable: process.execPath, argsPrefix: [cliScript], shell: false };
  }

  return { executable: "codex", argsPrefix: [], shell: process.platform === "win32" };
}

function rpcError(method, error, stderr) {
  const detail = error?.message || JSON.stringify(error);
  return new Error(`Codex ${method} failed: ${detail}${formatStderr(stderr)}`);
}

function formatStderr(stderr) {
  const detail = `${stderr || ""}`.trim();
  return detail ? `; ${detail}` : "";
}

module.exports = { renameCodexThreadName, resolveCodexCommand };
